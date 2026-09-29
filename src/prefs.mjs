// 사람마다 고른 기본 번역 언어. 작은 JSON 파일 하나에 저장한다.
// 서버에서는 DATA_DIR 을 Railway 볼륨에 두어야 재배포해도 지워지지 않는다.
import fs from 'node:fs';
import path from 'node:path';

export function createPrefStore(file) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = {};
  }

  return {
    get(userId) {
      return data[userId] ?? null;
    },
    set(userId, code) {
      data[userId] = code;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file); // 쓰는 도중 꺼져도 기존 파일이 깨지지 않게
    },
    size() {
      return Object.keys(data).length;
    },
  };
}

export function createMemoryPrefStore() {
  const data = new Map();
  return {
    get: (userId) => data.get(userId) ?? null,
    set: (userId, code) => { data.set(userId, code); },
    size: () => data.size,
  };
}
