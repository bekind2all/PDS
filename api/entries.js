const DATA_SOURCE_ID = 'd0dc3c63-f1da-4872-8bb4-a3996953ab61';
const NOTION_VERSION = '2026-03-11';

const ALLOWED_MOODS = new Set([
  '😄 최고',
  '🙂 좋음',
  '😐 보통',
  '😕 아쉬움',
  '😣 힘듦',
]);

const ALLOWED_TAGS = new Set(['업무', '학습', '건강', '관계', '개인']);

function getNotionToken() {
  return (
    process.env.NOTION_API_KEY ||
    process.env.NOTION_TOKEN ||
    process.env.NOTION_SECRET ||
    ''
  ).trim();
}

function getAccessKey() {
  return (process.env.PDS_ACCESS_KEY || '').trim();
}

function send(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(payload);
}

function hasValidAccessKey(req) {
  const required = getAccessKey();
  if (!required) return true;
  const supplied = req.headers['x-pds-access-key'];
  return typeof supplied === 'string' && supplied === required;
}

function splitText(value, max = 1900) {
  const text = String(value || '');
  if (!text) return [];

  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + max, text.length);
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff && end < text.length) end -= 1;
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

function toRichText(value) {
  return splitText(value).map((content) => ({
    type: 'text',
    text: { content },
  }));
}

function readRichText(property) {
  return (property?.rich_text || [])
    .map((item) => item.plain_text || item.text?.content || '')
    .join('');
}

function readTitle(property) {
  return (property?.title || [])
    .map((item) => item.plain_text || item.text?.content || '')
    .join('');
}

function pageToEntry(page) {
  const properties = page?.properties || {};
  return {
    id: page.id,
    url: page.url,
    title: readTitle(properties['회고']),
    date: properties['날짜']?.date?.start || '',
    plan: readRichText(properties.Plan),
    do: readRichText(properties.Do),
    see: readRichText(properties.See),
    mood: properties['기분']?.select?.name || '',
    tags: (properties['태그']?.multi_select || []).map((tag) => tag.name),
  };
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function normalizePayload(body) {
  const payload = body && typeof body === 'object' ? body : {};
  const normalized = {
    date: String(payload.date || '').trim(),
    plan: String(payload.plan || '').trim(),
    do: String(payload.do || '').trim(),
    see: String(payload.see || '').trim(),
    mood: String(payload.mood || '').trim(),
    tags: Array.isArray(payload.tags)
      ? payload.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : [],
  };

  if (!isValidDate(normalized.date)) {
    throw Object.assign(new Error('올바른 날짜를 선택해주세요.'), { status: 400 });
  }
  if (!normalized.plan && !normalized.do && !normalized.see) {
    throw Object.assign(new Error('Plan, Do, See 중 하나 이상 기록해주세요.'), {
      status: 400,
    });
  }
  if ([normalized.plan, normalized.do, normalized.see].some((text) => text.length > 10000)) {
    throw Object.assign(new Error('Plan, Do, See는 각 10,000자 이하로 입력해주세요.'), {
      status: 400,
    });
  }
  if (normalized.mood && !ALLOWED_MOODS.has(normalized.mood)) {
    throw Object.assign(new Error('기분 선택값이 PDS 회고 DB와 일치하지 않습니다.'), {
      status: 400,
    });
  }
  if (normalized.tags.some((tag) => !ALLOWED_TAGS.has(tag))) {
    throw Object.assign(new Error('태그 선택값이 PDS 회고 DB와 일치하지 않습니다.'), {
      status: 400,
    });
  }

  normalized.tags = [...new Set(normalized.tags)];
  return normalized;
}

function buildProperties(payload) {
  return {
    '회고': {
      title: toRichText(`${payload.date} PDS 회고`),
    },
    '날짜': {
      date: { start: payload.date },
    },
    Plan: {
      rich_text: toRichText(payload.plan),
    },
    Do: {
      rich_text: toRichText(payload.do),
    },
    See: {
      rich_text: toRichText(payload.see),
    },
    '기분': {
      select: payload.mood ? { name: payload.mood } : null,
    },
    '태그': {
      multi_select: payload.tags.map((name) => ({ name })),
    },
  };
}

async function notionRequest(path, { method = 'GET', body } = {}) {
  const token = getNotionToken();
  if (!token) {
    throw Object.assign(new Error('Vercel의 Notion 인증 설정이 없습니다.'), {
      status: 503,
      code: 'NOTION_CONFIG_MISSING',
    });
  }

  const response = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || 'Notion 요청을 처리하지 못했습니다.');
    error.status = response.status;
    error.code = data.code || 'NOTION_ERROR';
    throw error;
  }
  return data;
}

async function findEntryByDate(date) {
  const result = await notionRequest(`/data_sources/${DATA_SOURCE_ID}/query`, {
    method: 'POST',
    body: {
      filter: {
        property: '날짜',
        date: { equals: date },
      },
      page_size: 1,
    },
  });
  return result.results?.find((item) => item.object === 'page') || null;
}

async function listRecentEntries() {
  const result = await notionRequest(`/data_sources/${DATA_SOURCE_ID}/query`, {
    method: 'POST',
    body: {
      sorts: [{ property: '날짜', direction: 'descending' }],
      page_size: 12,
    },
  });
  return (result.results || [])
    .filter((item) => item.object === 'page')
    .map(pageToEntry);
}

async function saveEntry(payload) {
  const existing = await findEntryByDate(payload.date);
  const properties = buildProperties(payload);

  if (existing) {
    const updated = await notionRequest(`/pages/${existing.id}`, {
      method: 'PATCH',
      body: { properties },
    });
    return { updated: true, entry: pageToEntry(updated) };
  }

  const created = await notionRequest('/pages', {
    method: 'POST',
    body: {
      parent: {
        type: 'data_source_id',
        data_source_id: DATA_SOURCE_ID,
      },
      properties,
    },
  });
  return { updated: false, entry: pageToEntry(created) };
}

function notionFailurePayload(error) {
  if (error.status === 404 || error.status === 403) {
    return {
      status: 503,
      payload: {
        code: 'NOTION_DATABASE_ACCESS',
        message:
          'Vercel의 Notion 연결이 기존 PDS 회고 DB에 접근하지 못합니다. Notion에서 해당 DB를 연결에 공유해주세요.',
      },
    };
  }
  if (error.status === 429) {
    return {
      status: 503,
      payload: {
        code: 'NOTION_RATE_LIMIT',
        message: 'Notion 요청이 많습니다. 잠시 후 다시 시도해주세요.',
      },
    };
  }
  if (error.status >= 400 && error.status < 500) {
    return {
      status: 400,
      payload: { code: error.code || 'NOTION_REQUEST_ERROR', message: error.message },
    };
  }
  return {
    status: 503,
    payload: {
      code: error.code || 'NOTION_UNAVAILABLE',
      message: 'Notion 연결이 일시적으로 응답하지 않습니다.',
    },
  };
}

module.exports = async function handler(req, res) {
  if (!hasValidAccessKey(req)) {
    return send(res, 401, {
      code: 'ACCESS_KEY_REQUIRED',
      message: '접근 키가 필요하거나 올바르지 않습니다.',
    });
  }

  try {
    if (req.method === 'GET') {
      const entries = await listRecentEntries();
      return send(res, 200, {
        entries,
        accessKeyRequired: Boolean(getAccessKey()),
      });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
      const payload = normalizePayload(body);
      const result = await saveEntry(payload);
      return send(res, 200, { ok: true, ...result });
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { message: '지원하지 않는 요청 방식입니다.' });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return send(res, 400, { message: '요청 형식이 올바르지 않습니다.' });
    }
    if (error.status === 400 && !error.code) {
      return send(res, 400, { message: error.message });
    }
    if (error.code === 'NOTION_CONFIG_MISSING') {
      return send(res, 503, { code: error.code, message: error.message });
    }

    const failure = notionFailurePayload(error);
    return send(res, failure.status, failure.payload);
  }
};
