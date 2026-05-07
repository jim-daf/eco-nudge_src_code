/**
 * Eye-Tracking Data Server
 *
 * Receives and stores eye-tracking research data:
 *   - CSV exports (raw gaze, fixations, saccades, AOI metrics, session summary)
 *   - Video recordings (screen capture, face+voice)
 *   - Heatmap images
 *   - Full session JSON
 *
 * Files are stored in Azure Blob Storage under eyetracking-uploads/<sessionId>/
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const { BlobServiceClient } = require('@azure/storage-blob');

const BCRYPT_ROUNDS = 12;
const SESSION_TTL_HOURS = 72; // sessions expire after 72 hours

const app = express();
const PORT = process.env.PORT || 3000;

// ===== SQLite Database (sql.js - pure JS, no native bindings) =====
const DB_PATH = path.join(__dirname, 'users.db');
let db; // initialized in start()

/** Persist the in-memory database to disk */
function saveDb() {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
}

/** Run a SELECT query and return the first matching row as an object, or null */
function dbGet(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    let row = null;
    if (stmt.step()) {
        row = stmt.getAsObject();
    }
    stmt.free();
    return row;
}

/** Run an INSERT/UPDATE/DELETE and persist. Returns { lastInsertRowid, changes } */
function dbRun(sql, params = []) {
    db.run(sql, params);
    const lastInsertRowid = db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0];
    const changes = db.exec('SELECT changes()')[0]?.values[0]?.[0];
    saveDb();
    return { lastInsertRowid, changes };
}

// ===== Azure Blob Storage =====
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = 'eyetracking-uploads';

let containerClient;
if (AZURE_STORAGE_CONNECTION_STRING) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
    containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    console.log(`[Blob] Connected to Azure Blob Storage container: ${CONTAINER_NAME}`);
} else {
    console.warn('[Blob] AZURE_STORAGE_CONNECTION_STRING not set - uploads will fail');
}

// ===== Middleware =====
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.text({ limit: '100mb', type: 'text/csv' }));

// Serve the frontend (parent directory contains index.html, app.js, etc.)
const FRONTEND_DIR = path.join(__dirname, '..');
app.use(express.static(FRONTEND_DIR, {
    index: 'index.html',
    // Don't serve the server folder or .git as static files
    setHeaders: (_res, filePath) => {
        if (filePath.includes('server') || filePath.includes('.git')) return;
    }
}));

// ===== Helpers =====

/** Sanitize session ID to prevent path traversal */
function sanitizeSessionId(sessionId) {
    // Only allow alphanumeric, underscores, and hyphens
    return String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '');
}

/** Sanitize filename */
function sanitizeFilename(name) {
    return String(name).replace(/[^a-zA-Z0-9_.\-]/g, '');
}

/** Build a blob path: <sessionId>/<filename> */
function blobPath(sessionId, filename) {
    const safe = sanitizeSessionId(sessionId);
    if (!safe) throw new Error('Invalid session ID');
    return `${safe}/${sanitizeFilename(filename)}`;
}

/** Upload a buffer or string to Azure Blob Storage */
async function uploadToBlob(sessionId, filename, content, contentType) {
    const blobName = blobPath(sessionId, filename);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
    await blockBlobClient.upload(buffer, buffer.length, {
        blobHTTPHeaders: { blobContentType: contentType || 'application/octet-stream' }
    });
    return blobName;
}

// ===== Multer config - use memory storage, then upload to blob =====
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB max per file
});

// ===== Routes =====

/**
 * POST /api/sessions/:sessionId/csv
 * Body JSON: { filename: "raw_gaze_data_ET_xxx.csv", content: "csv string" }
 */
app.post('/api/sessions/:sessionId/csv', async (req, res) => {
    try {
        const filename = sanitizeFilename(req.body.filename);
        if (!filename.endsWith('.csv')) {
            return res.status(400).json({ error: 'Filename must end with .csv' });
        }
        await uploadToBlob(req.params.sessionId, filename, req.body.content, 'text/csv');
        console.log(`[CSV] Saved ${filename} for session ${req.params.sessionId}`);
        res.json({ ok: true, filename });
    } catch (e) {
        console.error('[CSV] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/sessions/:sessionId/json
 * Body JSON: { filename: "full_session_xxx.json", data: { ... } }
 */
app.post('/api/sessions/:sessionId/json', async (req, res) => {
    try {
        const filename = sanitizeFilename(req.body.filename);
        if (!filename.endsWith('.json')) {
            return res.status(400).json({ error: 'Filename must end with .json' });
        }
        const content = JSON.stringify(req.body.data, null, 2);
        await uploadToBlob(req.params.sessionId, filename, content, 'application/json');
        console.log(`[JSON] Saved ${filename} for session ${req.params.sessionId}`);
        res.json({ ok: true, filename });
    } catch (e) {
        console.error('[JSON] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/sessions/:sessionId/recording
 * Multipart form: file field named "recording"
 */
app.post('/api/sessions/:sessionId/recording', upload.single('recording'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No recording file uploaded' });
    }
    try {
        const filename = sanitizeFilename(req.file.originalname);
        await uploadToBlob(req.params.sessionId, filename, req.file.buffer, req.file.mimetype);
        console.log(`[Recording] Saved ${filename} (${(req.file.size / 1024 / 1024).toFixed(1)} MB) for session ${req.params.sessionId}`);
        res.json({ ok: true, filename, size: req.file.size });
    } catch (e) {
        console.error('[Recording] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/sessions/:sessionId/heatmap
 * Multipart form: file field named "heatmap"
 */
app.post('/api/sessions/:sessionId/heatmap', upload.single('heatmap'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No heatmap file uploaded' });
    }
    try {
        const filename = sanitizeFilename(req.file.originalname);
        await uploadToBlob(req.params.sessionId, filename, req.file.buffer, req.file.mimetype);
        console.log(`[Heatmap] Saved ${filename} for session ${req.params.sessionId}`);
        res.json({ ok: true, filename, size: req.file.size });
    } catch (e) {
        console.error('[Heatmap] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/sessions/:sessionId/recording-chunk
 * Streams recording chunks during recording to avoid data loss.
 * Multipart form: file field named "chunk", body field "chunkIndex"
 */
app.post('/api/sessions/:sessionId/recording-chunk', upload.single('chunk'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No chunk uploaded' });
    }
    try {
        const filename = sanitizeFilename(req.file.originalname);
        await uploadToBlob(req.params.sessionId, filename, req.file.buffer, req.file.mimetype);
        res.json({ ok: true, filename, size: req.file.size });
    } catch (e) {
        console.error('[Chunk] Error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/sessions
 * List all sessions with their files
 */
app.get('/api/sessions', async (_req, res) => {
    try {
        const sessionsMap = {};
        for await (const blob of containerClient.listBlobsFlat()) {
            const parts = blob.name.split('/');
            if (parts.length < 2) continue;
            const sessionId = parts[0];
            const fileName = parts.slice(1).join('/');
            if (!sessionsMap[sessionId]) sessionsMap[sessionId] = [];
            sessionsMap[sessionId].push({
                name: fileName,
                size: blob.properties.contentLength,
            });
        }
        const sessions = Object.entries(sessionsMap).map(([sessionId, files]) => ({
            sessionId,
            files,
        }));
        res.json({ sessions });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/sessions/:sessionId/files
 * List files for a specific session
 */
app.get('/api/sessions/:sessionId/files', async (req, res) => {
    try {
        const prefix = sanitizeSessionId(req.params.sessionId) + '/';
        const files = [];
        for await (const blob of containerClient.listBlobsFlat({ prefix })) {
            files.push({
                name: blob.name.replace(prefix, ''),
                size: blob.properties.contentLength,
            });
        }
        res.json({ sessionId: req.params.sessionId, files });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/sessions/:sessionId/files/:filename
 * Download a specific file
 */
app.get('/api/sessions/:sessionId/files/:filename', async (req, res) => {
    try {
        const blobName = blobPath(req.params.sessionId, req.params.filename);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        const exists = await blockBlobClient.exists();
        if (!exists) {
            return res.status(404).json({ error: 'File not found' });
        }
        const downloadResponse = await blockBlobClient.download(0);
        const filename = sanitizeFilename(req.params.filename);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        if (downloadResponse.contentType) {
            res.setHeader('Content-Type', downloadResponse.contentType);
        }
        downloadResponse.readableStreamBody.pipe(res);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===== User Routes =====

/** Validate and sanitize a username */
function validateUsername(raw) {
    const trimmed = (raw || '').trim();
    if (!trimmed || trimmed.length < 2 || trimmed.length > 30) {
        return { error: 'Username must be 2-30 characters' };
    }
    // Only allow letters, numbers, underscores, hyphens (no spaces)
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
        return { error: 'Username can only contain letters, numbers, _ and -' };
    }
    return { username: trimmed };
}

// ===== Session helpers =====

/** Generate a secure random session token */
function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

/** Create a session for a user, return token */
function createSession(userId) {
    const token = generateSessionToken();
    dbRun(
        `INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_TTL_HOURS} hours'))`,
        [token, userId]
    );
    // Clean up expired sessions periodically
    dbRun("DELETE FROM sessions WHERE expires_at < datetime('now')", []);
    return token;
}

/** Strip password_hash from user object before sending to client */
function sanitizeUser(user) {
    if (!user) return null;
    const { password_hash, ...safe } = user;
    return safe;
}

/** Validate password strength */
function validatePassword(password) {
    if (!password || typeof password !== 'string') {
        return 'Password is required';
    }
    if (password.length < 6) {
        return 'Password must be at least 6 characters';
    }
    if (password.length > 128) {
        return 'Password must be at most 128 characters';
    }
    return null;
}

// ===== Auth middleware =====

/** Authenticate request via Bearer token or x-session-token header */
function requireAuth(req, res, next) {
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
    } else {
        token = req.headers['x-session-token'];
    }

    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    const session = dbGet(
        "SELECT s.*, u.username, u.display_name, u.id as uid FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > datetime('now')",
        [token]
    );

    if (!session) {
        return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
    }

    req.user = { id: session.uid, username: session.username, display_name: session.display_name };
    next();
}

/**
 * POST /api/users/signup
 * Body JSON: { username: "alice", password: "secret123" }
 * Creates a new user with hashed password. Returns session token.
 */
app.post('/api/users/signup', async (req, res) => {
    try {
        const { username, error } = validateUsername(req.body.username);
        if (error) return res.status(400).json({ error });

        const pwError = validatePassword(req.body.password);
        if (pwError) return res.status(400).json({ error: pwError });

        const existing = dbGet('SELECT id FROM users WHERE username = ?', [username]);
        if (existing) {
            return res.status(409).json({ error: 'Username is already taken. Please choose another.' });
        }

        const passwordHash = await bcrypt.hash(req.body.password, BCRYPT_ROUNDS);
        const info = dbRun(
            'INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)',
            [username, username, passwordHash]
        );
        const user = dbGet('SELECT * FROM users WHERE id = ?', [info.lastInsertRowid]);
        const token = createSession(user.id);
        console.log(`[User] New user created: ${username}`);
        res.json({ ok: true, user: sanitizeUser(user), token });
    } catch (e) {
        console.error('[User] Signup error:', e.message);
        res.status(500).json({ error: 'An internal error occurred.' });
    }
});

/**
 * POST /api/users/login
 * Body JSON: { username: "alice", password: "secret123" }
 * Logs in existing user. Returns session token.
 */
app.post('/api/users/login', async (req, res) => {
    try {
        const { username, error } = validateUsername(req.body.username);
        if (error) return res.status(400).json({ error });

        if (!req.body.password) {
            return res.status(400).json({ error: 'Password is required' });
        }

        const user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) {
            // Use generic message to prevent username enumeration
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const match = await bcrypt.compare(req.body.password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        dbRun('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?', [user.id]);
        const token = createSession(user.id);
        console.log(`[User] Login: ${username}`);
        res.json({ ok: true, user: sanitizeUser(user), token });
    } catch (e) {
        console.error('[User] Login error:', e.message);
        res.status(500).json({ error: 'An internal error occurred.' });
    }
});

/**
 * POST /api/users/logout
 * Invalidates the current session token.
 */
app.post('/api/users/logout', requireAuth, (req, res) => {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '') || req.headers['x-session-token'];
    if (token) {
        dbRun('DELETE FROM sessions WHERE token = ?', [token]);
    }
    res.json({ ok: true });
});

/**
 * GET /api/users/me
 * Get current authenticated user profile.
 */
app.get('/api/users/me', requireAuth, (req, res) => {
    const user = dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: sanitizeUser(user) });
});

/**
 * GET /api/users/:username
 * Get user profile (public info only)
 */
app.get('/api/users/:username', (req, res) => {
    try {
        const username = req.params.username.replace(/[^a-zA-Z0-9_-]/g, '');
        const user = dbGet('SELECT id, username, display_name, created_at FROM users WHERE username = ?', [username]);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ user });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * PUT /api/users/:username
 * Body JSON: { display_name: "Alice S." }
 * Requires authentication and can only update own profile.
 */
app.put('/api/users/:username', requireAuth, (req, res) => {
    try {
        const username = req.params.username.replace(/[^a-zA-Z0-9_-]/g, '');
        // Users can only update their own profile
        if (req.user.username.toLowerCase() !== username.toLowerCase()) {
            return res.status(403).json({ error: 'You can only update your own profile.' });
        }
        const displayName = (req.body.display_name || '').trim().slice(0, 50);
        if (!displayName) {
            return res.status(400).json({ error: 'display_name is required' });
        }
        const result = dbRun(
            'UPDATE users SET display_name = ? WHERE username = ?',
            [displayName, username]
        );
        if (result.changes === 0) return res.status(404).json({ error: 'User not found' });
        const user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
        res.json({ ok: true, user: sanitizeUser(user) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ===== Start =====
async function start() {
    // Initialize sql.js and load or create the database
    const SQL = await initSqlJs();
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
        console.log(`[DB] Loaded existing SQLite database from ${DB_PATH}`);
    } else {
        db = new SQL.Database();
        console.log(`[DB] Created new SQLite database`);
    }

    // Create users table if it doesn't exist
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        last_login TEXT DEFAULT (datetime('now'))
      )
    `);

    // Create sessions table
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    saveDb();
    console.log(`[DB] SQLite database ready at ${DB_PATH}`);

    app.listen(PORT, () => {
        console.log(`\n  Eye-Tracking Data Server running on http://localhost:${PORT}`);
        console.log(`  Storage: Azure Blob Storage (${CONTAINER_NAME})\n`);
    });
}

start().catch(err => {
    console.error('[FATAL] Server failed to start:', err);
    process.exit(1);
});
