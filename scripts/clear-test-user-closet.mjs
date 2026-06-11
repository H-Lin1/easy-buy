import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...parseEnvFile(path.join(projectRoot, ".env.local")),
  ...process.env,
};

const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const testEmail = env.test_User ?? env.TEST_USER;
const testPassword = env.test_Password ?? env.TEST_PASSWORD;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is missing.");
}

if (!testEmail || !testPassword) {
  throw new Error("test_User or test_Password is missing from .env.local.");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
  email: testEmail,
  password: testPassword,
});

if (authError || !authData.user) {
  throw new Error(`Test account sign-in failed: ${authError?.message ?? "missing user"}`);
}

const userId = authData.user.id;

const { data: rows, error: selectError } = await supabase
  .from("closet_items")
  .select("id,image_path,processed_image_path,display_image_path")
  .eq("user_id", userId);

if (selectError) throw selectError;

const paths = new Set(
  (rows ?? [])
    .flatMap((row) => [row.image_path, row.processed_image_path, row.display_image_path])
    .filter(Boolean),
);

for (const pathFromList of await listStoragePaths(userId)) {
  paths.add(pathFromList);
}

const pathList = [...paths];
for (let index = 0; index < pathList.length; index += 100) {
  const batch = pathList.slice(index, index + 100);
  if (!batch.length) continue;

  const { error } = await supabase.storage.from("closet-images").remove(batch);
  if (error) {
    console.warn(`Storage cleanup warning: ${error.message}`);
  }
}

const { error: deleteError } = await supabase.from("closet_items").delete().eq("user_id", userId);
if (deleteError) throw deleteError;

console.log(
  `Cleared closet for test user. Removed ${rows?.length ?? 0} database row(s) and ${pathList.length} storage object(s).`,
);

async function listStoragePaths(prefix) {
  const collected = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase.storage.from("closet-images").list(prefix, {
      limit: 100,
      offset,
    });

    if (error) {
      console.warn(`Storage list warning at ${prefix}: ${error.message}`);
      return collected;
    }

    if (!data?.length) return collected;

    for (const item of data) {
      const itemPath = `${prefix}/${item.name}`;

      if (item.id || item.metadata?.size !== undefined) {
        collected.push(itemPath);
      } else {
        collected.push(...(await listStoragePaths(itemPath)));
      }
    }

    if (data.length < 100) return collected;
    offset += data.length;
  }
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const result = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}
