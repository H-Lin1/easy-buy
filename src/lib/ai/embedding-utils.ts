export function createDeterministicEmbedding(text: string, dimensions: number) {
  const values = new Array<number>(dimensions).fill(0);

  for (let index = 0; index < text.length; index += 1) {
    const bucket = index % dimensions;
    values[bucket] += (text.charCodeAt(index) % 97) / 97;
  }

  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

export function normalizeEmbeddingToDimensions(embedding: number[], dimensions: number) {
  if (embedding.length === dimensions) return embedding;
  if (embedding.length > dimensions) return embedding.slice(0, dimensions);

  return [...embedding, ...new Array<number>(dimensions - embedding.length).fill(0)];
}

export function formatPgVector(embedding: number[]) {
  return `[${embedding.map((value) => Number(value.toFixed(8))).join(",")}]`;
}
