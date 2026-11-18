// Host half of the BT search plugin.
//
// The sidebar panel runs in the Web page, where most trackers refuse
// cross-origin requests. This half answers one same-origin route with the
// normalized results, so the page never talks to an upstream host directly.

import { searchAll } from './sources.js';

const ROUTE = '/plugins/dsh-plugin-bt-search/search';
// 磁力猫实测最多 80 页、12 条/页。新接口 offset/limit（条数窗口）默认每页 20 条、
// 单次最多 120 条；旧接口 page/pages（1 基站点页）保留向后兼容。
const MAX_PAGE = 80;
const DEFAULT_PAGES = 5;
const MAX_PAGES_PER_REQUEST = 10;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 120;
const SORTS = ['date', 'size', 'name'];

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', String(body.length));
  response.setHeader('Cache-Control', 'no-store');
  response.end(body);
}

function untrusted(ctx, request, response) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
  if (!connection || typeof connection.requestRejection !== 'function') return false;
  const rejection = connection.requestRejection(request);
  if (rejection === undefined) return false;
  response.statusCode = typeof rejection === 'number' ? rejection : 403;
  response.end();
  return true;
}

async function handleSearch(ctx, request, response) {
  if ((request.method || 'GET').toUpperCase() !== 'GET') {
    sendJson(response, 405, { results: [], errors: [{ source: 'all', message: '仅支持 GET' }] });
    return;
  }
  if (untrusted(ctx, request, response)) return;

  let url;
  try {
    url = new URL(request.url || '/', 'http://127.0.0.1');
  } catch {
    sendJson(response, 400, { results: [], errors: [{ source: 'all', message: '非法请求' }] });
    return;
  }
  const params = url.searchParams;
  const mode = params.get('mode') === 'precise' ? 'precise' : 'broad';
  const sortRaw = params.get('sort') || 'date';
  const sort = SORTS.includes(sortRaw) ? sortRaw : 'date';
  // 新调用方传 offset/limit（条数窗口）；两者都缺省且带 page/pages 时走旧语义。
  const queryArgs = { offset: undefined, limit: undefined, page: undefined, pages: undefined };
  if (params.has('offset') || params.has('limit')) {
    const rawOffset = Number.parseInt(params.get('offset') || '0', 10);
    queryArgs.offset = Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0);
    const rawLimit = Number.parseInt(params.get('limit') || String(DEFAULT_LIMIT), 10);
    queryArgs.limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT),
    );
  } else {
    const rawPage = Number.parseInt(params.get('page') || '1', 10);
    queryArgs.page = Math.min(MAX_PAGE, Math.max(1, Number.isFinite(rawPage) ? rawPage : 1));
    const rawPages = Number.parseInt(params.get('pages') || String(DEFAULT_PAGES), 10);
    queryArgs.pages = Math.min(
      MAX_PAGES_PER_REQUEST,
      Math.max(1, Number.isFinite(rawPages) ? rawPages : DEFAULT_PAGES),
    );
  }

  try {
    const payload = await searchAll({
      q: params.get('q') || '',
      source: params.get('source') || 'all',
      type: params.get('type') || '',
      mode,
      sort,
      ...queryArgs,
    });
    sendJson(response, 200, payload);
  } catch (error) {
    sendJson(response, 500, {
      results: [],
      errors: [{ source: 'all', message: error && error.message ? error.message : String(error) }],
    });
  }
}

export function apply(ctx) {
  ctx.inject?.(['webServer'], (web) => {
    try {
      ctx.effect(
        () => web.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: (request, response) => handleSearch(ctx, request, response),
        }),
        'bt-search: search route',
      );
    } catch (error) {
      // 另一个插件副本已占用该路径时不应让整个插件失效。
      console.warn('[bt-search] search route not registered:', error && error.message);
    }
  });
}
