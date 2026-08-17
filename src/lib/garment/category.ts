export type GarmentCategoryGroup = "top" | "outerwear" | "bottom" | "onepiece" | "unknown";

export type GarmentEvidenceRole =
  | "可搭上衣"
  | "可搭内搭"
  | "可搭外套"
  | "可搭裤装"
  | "可搭裙装"
  | "可搭套装"
  | "可搭单品";

const ONEPIECE_PATTERN = /连衣裙|连体裤|套装|旗袍/;
const BOTTOM_PATTERN = /裤|半身裙|短裙|长裙|牛仔裤|直筒|阔腿|西装裤|休闲裤|工装裤|户外裤|运动裤|卫裤|瑜伽裤|鲨鱼裤|打底裤|皮裤|裙裤|百褶裙|铅笔裙|A字裙/;
const OUTERWEAR_PATTERN = /西装外套|外套|开衫|夹克|大衣|风衣|马甲|防晒衣|冲锋衣|软壳|硬壳|抓绒|雨衣|雨壳|棒球|工装外套|牛仔外套|皮衣|羽绒|棉服|小香风/;
const TOP_PATTERN = /衬衫|上衣|T恤|针织|卫衣|毛衣|背心|吊带|短上衣|Polo|POLO|polo|打底|防晒衫|雪纺|羊毛衫|羊绒|运动内衣/;
const SKIRT_PATTERN = /半身裙|短裙|长裙|A字裙|铅笔裙|百褶裙|伞裙|包臀裙|裙装/;

export function classifyGarmentCategory(category: string): GarmentCategoryGroup {
  if (ONEPIECE_PATTERN.test(category)) return "onepiece";
  if (BOTTOM_PATTERN.test(category)) return "bottom";
  if (OUTERWEAR_PATTERN.test(category)) return "outerwear";
  if (TOP_PATTERN.test(category)) return "top";
  return "unknown";
}

export function getGarmentEvidenceRole(
  category: string,
  candidateCategory?: string,
  slot?: string,
): GarmentEvidenceRole {
  const group = classifyGarmentCategory(category);
  if (group === "bottom") return SKIRT_PATTERN.test(category) ? "可搭裙装" : "可搭裤装";
  if (group === "outerwear") return "可搭外套";
  if (group === "onepiece") return "可搭套装";
  if (group === "top") {
    if (slot === "inner_top") return "可搭内搭";
    if (slot === "top") return "可搭上衣";
    const candidateGroup = candidateCategory ? classifyGarmentCategory(candidateCategory) : "unknown";
    return candidateGroup === "outerwear" || /衬衫|开衫|马甲|防晒衫|针织开衫/.test(candidateCategory ?? "")
      ? "可搭内搭"
      : "可搭上衣";
  }
  return "可搭单品";
}
