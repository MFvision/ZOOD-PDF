#!/usr/bin/env node
// Adds Ask ZOOD's models to the on-device catalogue
// (packages/ui/src/ai/device/models.json) with the size and SHA-256 Hugging
// Face publishes for each file (its LFS pointer), so the app checks every
// download against them:
//
//   node scripts/pin-ask-models.mjs            # writes models.json
//   node scripts/pin-ask-models.mjs --dry-run  # prints what it would write
//
// It reads each repository's file list, takes the weights and the projector
// ("mmproj") named below, and refuses a file whose checksum or size is not
// published. Run it again to move to newer files; entries are replaced by id.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogueFile = join(repo, 'packages/ui/src/ai/device/models.json');

/**
 * Both Apache-2.0. The ear: Qwen3-ASR, speech to text in 52 languages and
 * dialects, Arabic among them, in llama.cpp's own conversion. The model that
 * decides and sees: Qwen3-VL Instruct, from Qwen's own repository.
 */
const WANTED = [
  {
    id: 'qwen3-asr-0.6b',
    name: 'Qwen3-ASR 0.6B (Q8_0)',
    repo: 'ggml-org/Qwen3-ASR-0.6B-GGUF',
    weights: [/q8_0\.gguf$/i, /\.gguf$/i],
    projector: [/^mmproj.*q8_0\.gguf$/i, /^mmproj.*f16\.gguf$/i, /^mmproj.*\.gguf$/i],
    ramGiB: 4,
    hears: true,
  },
  {
    id: 'qwen3-vl-4b',
    name: 'Qwen3-VL 4B Instruct (Q4_K_M)',
    repo: 'Qwen/Qwen3-VL-4B-Instruct-GGUF',
    weights: [/q4_k_m\.gguf$/i],
    projector: [/^mmproj.*q8_0\.gguf$/i, /^mmproj.*f16\.gguf$/i],
    ramGiB: 12,
    sees: true,
  },
];

async function files(name) {
  const url = `https://huggingface.co/api/models/${name}/tree/main?recursive=1`;
  const response = await fetch(url, { headers: { 'user-agent': 'zood-pdf-pin' } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return (await response.json()).filter((entry) => entry.type === 'file');
}

function pick(list, patterns, { projector }) {
  for (const pattern of patterns) {
    const found = list.find((entry) => {
      const base = entry.path.split('/').pop();
      return pattern.test(base) && base.toLowerCase().startsWith('mmproj') === projector;
    });
    if (found) return found;
  }
  return null;
}

function part(name, entry) {
  const sha256 = entry.lfs?.oid ?? entry.lfs?.sha256;
  const bytes = entry.lfs?.size ?? entry.size;
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? '') || !(bytes > 0)) throw new Error(`${name}/${entry.path}: no published checksum`);
  return { file: entry.path.split('/').pop(), url: `https://huggingface.co/${name}/resolve/main/${entry.path}`, sha256, bytes };
}

const catalogue = JSON.parse(readFileSync(catalogueFile, 'utf8'));
for (const want of WANTED) {
  const list = await files(want.repo);
  const weights = pick(list, want.weights, { projector: false });
  const projector = pick(list, want.projector, { projector: true });
  if (!weights || !projector) throw new Error(`${want.repo}: the weights or the projector is not there (${list.map((e) => e.path).join(', ')})`);
  const main = part(want.repo, weights);
  const entry = {
    id: want.id,
    name: want.name,
    ...main,
    repo: want.repo,
    ramGiB: want.ramGiB,
    licence: 'Apache-2.0',
    projector: part(want.repo, projector),
    ...(want.hears ? { hears: true } : {}),
    ...(want.sees ? { sees: true } : {}),
  };
  catalogue.models = catalogue.models.filter((model) => model.id !== want.id).concat(entry);
  console.log(`${want.id}: ${entry.file} (${main.bytes} bytes) + ${entry.projector.file} (${entry.projector.bytes} bytes)`);
}
const text = `${JSON.stringify(catalogue, null, 2)}\n`;
if (process.argv.includes('--dry-run')) console.log(text);
else writeFileSync(catalogueFile, text);
