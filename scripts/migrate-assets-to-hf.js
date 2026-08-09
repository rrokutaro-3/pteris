#!/usr/bin/env node
/**
 * Asset Migration Script: Cloudflare R2 → Hugging Face
 * 
 * When R2 approaches its 10GB limit, run this to archive older assets
 * to Hugging Face datasets while maintaining the same folder structure.
 * 
 * Usage:
 *   export HF_TOKEN=hf_xxx
 *   export R2_BUCKET=your-store-bucket
 *   export HF_REPO=yourusername/store-assets
 *   node scripts/migrate-assets-to-hf.js --older-than 90 --dry-run
 *
 * By default this only COPIES assets to Hugging Face and leaves the R2
 * originals in place — "archival" that never actually deletes anything
 * doesn't relieve R2 storage, which defeats the script's stated purpose
 * of staying under R2's 10GB limit. Pass --delete-source to delete each
 * R2 object once it has been verified present at the destination HF URL.
 * Deletion is opt-in (not the default) because it's irreversible from
 * this script's perspective — review a --dry-run first.
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const deleteSource = args.includes('--delete-source');
const olderThanDays = parseInt(args.find((a, i) => args[i - 1] === '--older-than') || '90');
const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

const R2_ENDPOINT = process.env.R2_ENDPOINT || 'https://your-account.r2.cloudflarestorage.com';
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const HF_TOKEN = process.env.HF_TOKEN;
const HF_REPO = process.env.HF_REPO;

if (!R2_ACCESS_KEY || !R2_SECRET_KEY || !R2_BUCKET || !HF_TOKEN || !HF_REPO) {
  console.error('Missing required env vars: R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET, HF_TOKEN, HF_REPO');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
});

async function listOldAssets(prefix = '') {
  const oldAssets = [];
  let continuationToken = null;

  do {
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    });

    const response = await s3.send(cmd);

    for (const obj of response.Contents || []) {
      if (obj.LastModified < cutoffDate) {
        oldAssets.push({
          key: obj.Key,
          size: obj.Size,
          lastModified: obj.LastModified,
        });
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  return oldAssets;
}

async function downloadAsset(key, localPath) {
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
  const response = await s3.send(cmd);
  const body = await response.Body.transformToByteArray();

  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, body);
}

/**
 * Confirm an asset is actually retrievable at its destination HF URL
 * before deleting the R2 original. Only used when --delete-source is
 * passed — deletion must never happen based on "the git push didn't
 * error" alone, since that doesn't guarantee the file is servable yet.
 */
async function verifyUploaded(hfUrl) {
  try {
    const res = await fetch(hfUrl, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

async function deleteFromR2(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

async function uploadToHuggingFace(localDir) {
  // Clone or create the HF dataset repo
  const repoUrl = `https://huggingface.co/datasets/${HF_REPO}`;

  try {
    execSync(`git clone https://user:${HF_TOKEN}@huggingface.co/datasets/${HF_REPO} hf-repo`, {
      cwd: '/tmp',
      stdio: 'pipe'
    });
  } catch {
    // Repo might already exist or need creation
    console.log('Repo exists or needs manual creation');
  }

  const repoPath = `/tmp/hf-repo`;

  // Copy files maintaining structure
  const files = await fs.readdir(localDir, { recursive: true });
  for (const file of files) {
    const src = path.join(localDir, file);
    const dest = path.join(repoPath, file);
    const stat = await fs.stat(src);
    if (stat.isFile()) {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
    }
  }

  // Commit and push
  execSync('git add .', { cwd: repoPath });
  execSync(`git commit -m "Archive assets older than ${olderThanDays} days"`, { cwd: repoPath });
  execSync('git push', { cwd: repoPath });
}

async function generateMigrationMap(oldAssets, hfBaseUrl) {
  // Create a JSON map: old R2 URL → new HF URL
  const map = {};
  for (const asset of oldAssets) {
    const r2Url = `${R2_ENDPOINT}/${R2_BUCKET}/${asset.key}`;
    const hfUrl = `${hfBaseUrl}/${asset.key}`;
    map[r2Url] = hfUrl;
  }
  return map;
}

async function main() {
  console.log(`🔍 Finding assets older than ${olderThanDays} days (before ${cutoffDate.toISOString()})...`);

  const oldAssets = await listOldAssets();
  console.log(`Found ${oldAssets.length} old assets (${(oldAssets.reduce((s, a) => s + a.size, 0) / 1024 / 1024).toFixed(2)} MB)`);

  if (oldAssets.length === 0) {
    console.log('Nothing to migrate.');
    return;
  }

  if (dryRun) {
    console.log('\n📋 Dry run — would migrate:');
    oldAssets.slice(0, 10).forEach(a => console.log(`  - ${a.key} (${(a.size / 1024 / 1024).toFixed(2)} MB)`));
    if (oldAssets.length > 10) console.log(`  ... and ${oldAssets.length - 10} more`);
    return;
  }

  // Download to temp
  const tempDir = `/tmp/r2-migrate-${Date.now()}`;
  await fs.mkdir(tempDir, { recursive: true });

  console.log('\n📥 Downloading assets...');
  for (let i = 0; i < oldAssets.length; i++) {
    const asset = oldAssets[i];
    const localPath = path.join(tempDir, asset.key);
    await downloadAsset(asset.key, localPath);
    process.stdout.write(`\r  ${i + 1}/${oldAssets.length} downloaded`);
  }
  console.log();

  // Upload to HF
  console.log('\n📤 Uploading to Hugging Face...');
  await uploadToHuggingFace(tempDir);

  // Generate URL migration map
  const hfBaseUrl = `https://huggingface.co/datasets/${HF_REPO}/resolve/main`;
  const migrationMap = await generateMigrationMap(oldAssets, hfBaseUrl);

  await fs.writeFile(
    './data/config/asset-migration.json',
    JSON.stringify({
      migratedAt: new Date().toISOString(),
      count: oldAssets.length,
      baseUrl: hfBaseUrl,
      map: migrationMap
    }, null, 2)
  );

  console.log('\n✅ Copy to Hugging Face complete!');
  console.log(`   ${oldAssets.length} assets copied to ${HF_REPO}`);
  console.log('   Migration map saved to data/config/asset-migration.json');
  console.log('   Next build will update product URLs to point to HF');

  // Delete R2 originals, but only if explicitly requested and only after
  // verifying each asset is actually retrievable from its new HF URL.
  // Without this step, "archival" only ever copies — R2 storage never
  // shrinks, which defeats the whole point of running this script when
  // approaching the 10GB limit.
  if (deleteSource) {
    console.log('\n🗑️  --delete-source: verifying + deleting R2 originals...');
    let deleted = 0;
    let skipped = 0;
    for (const asset of oldAssets) {
      const hfUrl = migrationMap[`${R2_ENDPOINT}/${R2_BUCKET}/${asset.key}`];
      const ok = await verifyUploaded(hfUrl);
      if (!ok) {
        console.warn(`   ⚠️  Skipping delete for ${asset.key} — not yet retrievable at ${hfUrl}`);
        skipped++;
        continue;
      }
      await deleteFromR2(asset.key);
      deleted++;
      process.stdout.write(`\r   ${deleted} deleted, ${skipped} skipped`);
    }
    console.log();
    console.log(`   Deleted ${deleted} of ${oldAssets.length} R2 originals (${skipped} skipped — not verified, left in place).`);
  } else {
    console.log('\n   R2 originals were left in place (pass --delete-source to remove them after verification).');
  }

  // Cleanup
  await fs.rm(tempDir, { recursive: true, force: true });
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
