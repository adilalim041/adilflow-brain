/**
 * vault_github.js — GitHub Contents API helper for Node services (CJS).
 *
 * Copied from ObsidianVault/system/lib/vault_github.js and adapted for
 * CommonJS (adilflow_brain uses require(), not ESM import).
 *
 * Env:
 *   VAULT_WRITE_TOKEN — fine-grained PAT, scope ObsidianVault/Contents=R/W
 *   VAULT_REPO        — defaults to "adilalim041/ObsidianVault"
 *   VAULT_BRANCH      — defaults to "main"
 *
 * Dependency: global fetch (Node >= 18, which brain already requires).
 */

'use strict';

const REPO   = process.env.VAULT_REPO   || 'adilalim041/ObsidianVault';
const BRANCH = process.env.VAULT_BRANCH || 'main';
const API    = 'https://api.github.com';

function assertToken() {
    if (!process.env.VAULT_WRITE_TOKEN) {
        throw new Error('VAULT_WRITE_TOKEN env missing');
    }
}

function headers() {
    assertToken();
    return {
        Authorization: `Bearer ${process.env.VAULT_WRITE_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
}

/**
 * Encode a vault path for use in GitHub API URLs.
 * Preserves forward slashes so the URL stays readable to GitHub.
 */
function encodePath(path) {
    return encodeURIComponent(path).replace(/%2F/g, '/');
}

/**
 * Read file from vault. Returns string or null if 404.
 */
async function readVault(path) {
    const url = `${API}/repos/${REPO}/contents/${encodePath(path)}?ref=${BRANCH}`;
    const res = await fetch(url, { headers: headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`readVault ${path}: ${res.status}`);
    const json = await res.json();
    return Buffer.from(json.content, 'base64').toString('utf-8');
}

/**
 * Write (create or update) file. Handles sha lookup for updates automatically.
 * commitMessage defaults to "chore({path}): update".
 */
async function writeVault(path, content, commitMessage) {
    const url = `${API}/repos/${REPO}/contents/${encodePath(path)}`;

    // Fetch current sha so GitHub accepts the PUT as an update (not a conflict).
    let sha = null;
    const existing = await fetch(`${url}?ref=${BRANCH}`, { headers: headers() });
    if (existing.ok) {
        sha = (await existing.json()).sha;
    }

    const body = {
        message: commitMessage || `chore(${path}): update`,
        content: Buffer.from(content, 'utf-8').toString('base64'),
        branch: BRANCH,
    };
    if (sha) body.sha = sha;

    const res = await fetch(url, {
        method: 'PUT',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`writeVault ${path}: ${res.status} ${text}`);
    }
    return await res.json();
}

/**
 * Write the current service heartbeat. Always bumps updated_at.
 *
 * @param {string} service  - e.g. "news-ai"
 * @param {string} status   - "healthy" | "degraded" | "down"
 * @param {object} details  - arbitrary service-specific payload
 */
async function writeHeartbeat(service, status, details = {}) {
    const payload = {
        service,
        updated_at: new Date().toISOString(),
        status,
        details,
        version: '1.0',
    };
    return writeVault(
        `system/status/${service}.json`,
        JSON.stringify(payload, null, 2) + '\n',
        `status(${service}): heartbeat`
    );
}

module.exports = { readVault, writeVault, writeHeartbeat };
