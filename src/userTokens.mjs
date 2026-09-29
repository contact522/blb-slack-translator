// 사람별 Slack 사용자 토큰. DM 은 봇이 들어갈 수 없어서, 본인이 허락한 토큰으로 🌐 를 단 메시지를 읽고 결과를 보낸다.
// - 파일(볼륨)에는 AES-256-GCM 으로 암호화해 저장한다. 해독 키(TOKEN_KEY)는 환경변수에만 있어, 볼륨만 새어서는 풀 수 없다.
// - 토큰을 쓸 때마다 감사 기록(누가·언제·무엇, 메시지 본문은 남기지 않음)을 남긴다.
// - 연결 해제·계정 비활성화 시 즉시 삭제한다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function encrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(key, packed) {
  const [iv, tag, enc] = packed.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function createUserTokenStore({ file, auditFile, keyHex, now = () => new Date() }) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('TOKEN_KEY 는 64자리 16진수여야 합니다.');
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = {};
  }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  };
  const audit = (line) => {
    const row = `${now().toISOString()} ${line}`;
    console.log(`[audit] ${row}`);
    try {
      fs.mkdirSync(path.dirname(auditFile), { recursive: true });
      fs.appendFileSync(auditFile, `${row}\n`);
    } catch {
      // 감사 파일 실패는 콘솔 기록으로 대신한다
    }
  };

  return {
    get(userId) {
      const row = data[userId];
      if (!row) return null;
      try {
        return decrypt(key, row.token);
      } catch {
        return null; // 해독 키가 바뀌었으면 다시 연결해야 한다
      }
    },
    set(userId, token, scope) {
      data[userId] = { token: encrypt(key, token), scope, at: now().toISOString() };
      save();
      audit(`connect user=${userId} scope=${scope}`);
    },
    delete(userId, reason) {
      if (!data[userId]) return;
      delete data[userId];
      save();
      audit(`disconnect user=${userId} reason=${reason}`);
    },
    // 🌐 처리 시 무엇을 읽었는지 남긴다. 대화방 종류와 id 만, 본문은 남기지 않는다.
    record(userId, channelType, channelId) {
      audit(`read user=${userId} type=${channelType} channel=${channelId}`);
    },
    has(userId) {
      return Boolean(data[userId]);
    },
    size() {
      return Object.keys(data).length;
    },
  };
}

export function createMemoryUserTokenStore() {
  const data = new Map();
  const log = [];
  return {
    log,
    get: (u) => data.get(u) ?? null,
    set: (u, t, scope) => { data.set(u, t); log.push(`connect ${u} ${scope ?? ''}`.trim()); },
    delete: (u, reason) => { data.delete(u); log.push(`disconnect ${u} ${reason}`); },
    record: (u, type, ch) => { log.push(`read ${u} ${type} ${ch}`); },
    has: (u) => data.has(u),
    size: () => data.size,
  };
}
