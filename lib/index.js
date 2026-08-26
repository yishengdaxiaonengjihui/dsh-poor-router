/**
 * dsh-poor-router 宿主半 —— 穷鬼路由器
 * 免费LLM池：用量台账 / 健康追踪 / Beta后验TS自适应 / 同质量tier阶梯容灾 /
 * 执行者池 / 真钱护栏 / 时段桶v2 / 改道史落盘。由动态插件 poor-1/pkg-15 移植。
 *
 * 移植差异（相对动态版）：
 *   - ESM 导出 name/inject/apply；工具经 ctx.tools.register 进宿主注册表（全会话可见）
 *   - 面板 RPC 经 webServer 挂 /api/poor-router/*，客户端 fetch 直连
 */
export const name = 'poor-router'

/** fs：池与状态文件读写；webServer：面板/指示灯 HTTP 通道；tools：pool_status/pool_control 注册表（ctx.tools 属性访问必须显式 inject） */
export const inject = ['fs', 'webServer', 'tools']

export async function apply(ctx, config = {}) {

    const fs = ctx.get('fs');
    const webServer = ctx.webServer;
    // ---- 配置：数据目录与文件路径（默认 <cwd>/poor-router/，可在组合行 config 里覆盖）----
    const norm = (p) => String(p || '').replace(/\\/g, '/')
    const dirOf = (p) => { const s = norm(p); const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i > 0 ? s.slice(0, i) : '.' }
    const DATA_DIR0 = norm(config.dataDir) || (norm(process.cwd()) + '/poor-router')
    const POOL_PATH = norm(config.poolPath) || DATA_DIR0 + '/pool.json'
    const STATE_PATH = norm(config.statePath) || DATA_DIR0 + '/state.json'
    const IMPORT_PATH = norm(config.importPath) || DATA_DIR0 + '/import.json'
    const LAYER_RULES = Array.isArray(config.layerRules) ? config.layerRules : []
    const log = (...a) => console.log('[poor-router]', ...a);

    // ---- probe ----
    const probe = {
      streamFired: 0, requestFired: 0, errorFired: 0,
      metricsCaptured: 0,
      persistOk: 0, persistFail: 0, init: null, persistLog: [],
      fsApi: 'resolve/readText/writeText',
    };
    const probeLog = (m) => {
      probe.persistLog.push(new Date().toISOString() + ' ' + m);
      if (probe.persistLog.length > 30) probe.persistLog.shift();
    };

    let poolTarget, stateTarget;
    try {
      poolTarget = await fs.resolve(POOL_PATH);
      stateTarget = await fs.resolve(STATE_PATH);
      probe.init = 'resolve ok';
    } catch (e) {
      probe.init = 'resolve fail: ' + (e && e.message);
      probeLog('resolve fail: ' + (e && e.message));
    }

    const readJson = async (target, fb) => {
      if (!target) return fb;
      try { return JSON.parse(await fs.readText(target)); }
      catch (e) { log('readJson error', e && e.message); return fb; }
    };
    const WRITE_POLICY = { mode: 'workspace-write', workspaceRoot: dirOf(POOL_PATH) };
    const writeJson = async (target, o) => {
      if (!target) return;
      try {
        await fs.writeText(target, JSON.stringify(o, null, 2), undefined, undefined, WRITE_POLICY);
        probe.persistOk++;
        probeLog('wrote json ok');
      } catch (e) {
        probe.persistFail++;
        state._persistErrors = (state._persistErrors || 0) + 1;
        probeLog('WRITE FAIL: ' + (e && e.message));
      }
    };

    let pool = await readJson(poolTarget, { entries: [] });
    let state = await readJson(stateTarget, {});
    state.historyByEntryId = state.historyByEntryId || {};
    state.historyRing = state.historyRing || [];
    state.hourly = state.hourly || {};
    probe.init += '; loaded pool=' + (pool.entries ? pool.entries.length : 0);

    const ensure = async () => {
      if (!pool.entries || pool.entries.length === 0) pool = await readJson(poolTarget, { entries: [] });
    };
    const persist = async () => { await writeJson(stateTarget, state); };

    // Phase 6：真钱铃铛——复用宿主工具注册表的 text_me，按日去重
    const toolsSvc = ctx.get('tools');
    const todayKey = () => new Date().toISOString().slice(0, 10);
    const notifyOnce = (kind, msg) => {
      try {
        state.notified = state.notified || {};
        if (state.notified[kind] === todayKey()) return;
        state.notified[kind] = todayKey();
        const def = toolsSvc && toolsSvc.get ? toolsSvc.get('text_me') : null;
        if (def && typeof def.execute === 'function') {
          Promise.resolve(def.execute({ message: msg }))
            .then(() => probeLog('text_me ✓ ' + kind))
            .catch((e) => probeLog('text_me ✗ ' + kind + ': ' + (e && e.message)));
        } else {
          probeLog('text_me unavailable (' + kind + ')');
        }
      } catch (e) { probeLog('notify err: ' + (e && e.message)); }
    };
    let _seq = 0;

    // ---- routing core（内存态，决策零等待）----
    const ROUTE = { enabled: true, routedAway: 0, routedIn: 0, switches: [] };
    const ADAPTIVE = { enabled: true, picks: [] };
    const provCool = Object.create(null);
    const lastEntryByProvider = Object.create(null);
    // 软错误连击计数（超时/500/空响应等）：同供应商 10 分钟窗口内连击则指数升级冷却
    const softStrikes = Object.create(null);
    // Phase 7：重启恢复持久化的 provider 冷却（A3）
    for (const p of Object.keys(state.provCool || {})) {
      const t = state.provCool[p];
      if (t > Date.now()) provCool[p] = t;
    }
    // 层级默认规则：config.layerRules = [{ match: 'provider前缀', layer: 'backbone'|'burn'|'matchstick' }]
    // 未命中且条目未写 layer 字段时一律视为 burn（消耗品）。条目自身的 layer 字段永远优先。
    function layerOf(e) {
      if (e.layer) return e.layer;
      for (const r of LAYER_RULES) { try { if (String(r.match) && String(e.id).startsWith(String(r.match))) return r.layer; } catch (err2) { /* 跳过坏规则 */ } }
      return 'burn';
    }
    function splitId(id) { const i = id.indexOf('/'); return [id.slice(0, i), id.slice(i + 1)]; }
    function coolingEntry(e) {
      const manual = e.cooldownUntil ? Date.parse(e.cooldownUntil) : 0;
      return (e._cool || 0) > Date.now() || manual > Date.now();
    }
    function urg(e) { const t = e.expiresAt ? Date.parse(e.expiresAt) : Infinity; return Number.isNaN(t) ? Infinity : t; }
    // Phase 7：本地日期键（时段桶v2用，日期与小时同用本地时区避免UTC错位）
    function dayKeyLocal() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    function dayHourKey() { return dayKeyLocal() + ':' + String(new Date().getHours()); }

    // ---- 自适应评分（Phase 2）：Beta后验高斯近似 + 时段桶 + TTFT惩罚 ----
    function betaSample(okN, failN) {
      const n = okN + failN;
      const mean = (okN + 1) / (n + 2);
      const unc = 1 / Math.sqrt(n + 2);
      return Math.max(0, Math.min(1, mean + (Math.random() * 2 - 1) * unc));
    }
    function bucketStats(entryId) {
      const hm = state.hourly[entryId] || {};
      const cur = hm[dayHourKey()];
      let okN = 0, failN = 0, ttftSum = 0, ttftN = 0;
      for (const c of Object.values(hm)) {
        okN += c.ok || 0;
        failN += (c.fail || 0) + (c.error || 0);
        ttftSum += c.ttftSum || 0; ttftN += c.ttftN || 0;
      }
      if (cur && ((cur.ok || 0) + (cur.fail || 0)) >= 3) {
        okN += cur.ok || 0;
        failN += (cur.fail || 0) + (cur.error || 0);
        if (cur.ttftN) { ttftSum += cur.ttftSum; ttftN += cur.ttftN; }
      }
      return { ok: okN, fail: failN, n: okN + failN, ttftAvg: ttftN ? Math.round(ttftSum / ttftN) : null };
    }
    function scoreOf(entryId) {
      const s = bucketStats(entryId);
      const theta = betaSample(s.ok, s.fail);
      let lat = 1;
      if (s.ttftAvg != null && s.ttftAvg > 3000) lat = Math.max(0.5, 3000 / s.ttftAvg);
      return { v: theta * lat, stats: s };
    }
    function congested(entryId) {
      if (!ADAPTIVE.enabled) return false;
      const hm = state.hourly[entryId] || {};
      const cur = hm[dayHourKey()];
      if (!cur) return false;
      const n = (cur.ok || 0) + (cur.fail || 0) + (cur.error || 0);
      return n >= 4 && ((cur.fail || 0) + (cur.error || 0)) / n > 0.6;
    }

    // ---- Phase 4：真钱护栏 ----
    function paidSpendToday(entryId) {
      const pd = state.paidSpend || {};
      const r = pd[entryId];
      if (!r) return 0;
      const dk = new Date().toISOString().slice(0, 10);
      return r.dayKey === dk ? (r.spendYuan || 0) : 0;
    }
    function capOf(e) {
      const c = Number(e.dailyCapYuan);
      return Number.isFinite(c) && c > 0 ? c : Infinity;
    }
    // 免费候选全灭时的最后手段：付费逃生舱——必须用户显式授权（面板总闸 state.ui.paidAllowed），
    // 且单模型仍需 escapeHatch 标记 + 当日限额内。未授权一律拒绝：宁可本请求失败，绝不花钱。
    function escapePick(excludeId) {
      if (!(state.ui && state.ui.paidAllowed === true)) {
        probe.blockedEscapes = (probe.blockedEscapes || 0) + 1;
        probeLog('⛔ ESCAPE BLOCKED（付费未获授权）→ 本请求失败，不花钱');
        return null;
      }
      const now = Date.now();
      let best = null;
      for (const e of (pool.entries || [])) {
        if (!e.paid || !e.escapeHatch || e.disabled) continue;
        if (e.id === excludeId) continue;
        if ((e._cool || 0) > now) continue;
        if (e.cooldownUntil && Date.parse(e.cooldownUntil) > now) continue;
        if (provCool[splitId(e.id)[0]] > now) continue;
        if (paidSpendToday(e.id) >= capOf(e)) continue;
        if (!best) { best = e; continue; }
        const bo = Number(best.priceOutYuanPerM) || Infinity;
        const eo = Number(e.priceOutYuanPerM) || Infinity;
        if (eo < bo) best = e;
      }
      if (best) {
        probe.paidEscapes = (probe.paidEscapes || 0) + 1;
        probeLog('⚠ ESCAPE HATCH → ' + best.id + ' (今日已花 ¥' + paidSpendToday(best.id).toFixed(3) + ')');
        notifyOnce('escape', '⚠️穷鬼路由器：免费候选全灭，逃生舱启动 → ' + best.id + '（今日已花 ¥' + paidSpendToday(best.id).toFixed(2) + '/上限¥' + capOf(best) + '）');
      }
      return best;
    }
    function resolveAlt(curEntry, excludeProvider) {
      const a = pickAlt(curEntry, excludeProvider);
      if (a) return a;
      return escapePick(curEntry ? curEntry.id : '');
    }

    // ---- Phase 4：强规划弱执行——执行者池 ----
    function execRemaining(e) {
      const h = state.historyByEntryId[e.id] || {};
      const used = (h.tokInTotal || 0) + (h.tokOutTotal || 0);
      const grant = e.grantRemaining != null ? Number(e.grantRemaining) : (e.grant != null ? Number(e.grant) : null);
      if (grant == null || !Number.isFinite(grant)) return -1; // 未知额度排最后
      return Math.max(0, grant - used);
    }
    // Phase 6：执行者速度硬闸——TTFT EMA 超 30s 的模型不配干杂活
    function ttftOk(entryId) {
      const h = state.historyByEntryId[entryId];
      return !(h && h.ttftEmaMs != null && h.ttftEmaMs > 30000);
    }
    function pickExecutor() {
      const now = Date.now();
      const cands = (pool.entries || []).filter(e => e.role === 'executor' && layerOf(e) !== 'backbone' && !e.disabled
        && !(e._cool > now) && !(e.cooldownUntil && Date.parse(e.cooldownUntil) > now)
        && !(provCool[splitId(e.id)[0]] > now)
        && !congested(e.id) && ttftOk(e.id));
      if (!cands.length) return null;
      cands.sort((a, b) => execRemaining(b) - execRemaining(a));
      return tsPick(cands.slice(0, 3), 'executor') || cands[0];
    }
    // Phase 6：epsilon 探索——每第6笔杂活改投非执行者池的冷门免费模型（保护backbone战略储备）
    let _auxSeq = 0;
    function pickAuxTarget() {
      const t = pickExecutor();
      if (!t) return null;
      _auxSeq++;
      if (_auxSeq % 6 !== 1) return { target: t, why: '' };
      const now = Date.now();
      const cands = (pool.entries || []).filter(e => e.id !== t.id && !e.paid && !e.disabled
        && e.role !== 'executor' && layerOf(e) !== 'backbone'
        && !(e._cool > now) && !(e.cooldownUntil && Date.parse(e.cooldownUntil) > now)
        && !(provCool[splitId(e.id)[0]] > now)
        && !congested(e.id) && ttftOk(e.id));
      if (!cands.length) return { target: t, why: '' };
      const fresh = cands.filter(e => { const h = state.historyByEntryId[e.id]; return !(h && h.calls > 0); });
      const src = (fresh.length ? fresh : cands).slice().sort((a, b) => urg(a) - urg(b)).slice(0, 3);
      const ex = tsPick(src, 'aux-explore');
      if (!ex || ex.id === t.id) return { target: t, why: '' };
      probe.auxExplores = (probe.auxExplores || 0) + 1;
      return { target: ex, why: 'aux-explore' };
    }
    function tsPick(list, why) {
      if (!list.length) return null;
      if (!ADAPTIVE.enabled || list.length === 1) return list[0];
      let best = null, bestV = -1;
      for (const e of list) {
        const r = scoreOf(e.id);
        ADAPTIVE.picks.push({ id: e.id, v: Math.round(r.v * 1000) / 1000, why });
        if (r.v > bestV) {
          bestV = r.v; best = e;
          const s = r.stats;
          const clean = { ok: s.ok || 0, fail: s.fail || 0, n: s.n || 0 };
          if (s.ttftAvg != null) clean.ttftAvg = s.ttftAvg;
          probe.lastPickStats = { why, winner: e.id, stats: clean };
        }
      }
      while (ADAPTIVE.picks.length > 15) ADAPTIVE.picks.shift();
      return best || list[0];
    }

    function logSwitch(from, toId, why) {
      const rec = { from, to: toId, why, at: new Date().toISOString() };
      ROUTE.switches.push(rec);
      if (ROUTE.switches.length > 10) ROUTE.switches.shift();
      // Phase 7：改道史落盘（环形50条，重启可复盘）(A2)
      state.switchLog = state.switchLog || [];
      state.switchLog.push(rec);
      if (state.switchLog.length > 50) state.switchLog = state.switchLog.slice(-50);
      probe.lastSwitch = rec;
      return rec;
    }
    function swap(options, to, why) {
      const from = options.provider + '/' + options.model;
      const parts = splitId(to.id);
      logSwitch(from, to.id, why);
      ROUTE.routedAway++;
      options.provider = parts[0];
      options.model = parts[1];
    }
    function estimateTokens(options) {
      try {
        let n = (options.system || '').length;
        if (Array.isArray(options.messages)) n += JSON.stringify(options.messages).length;
        return n / 4;
      } catch (e) { return Infinity; }
    }
    // Phase 6：同级圈探索——34%概率把一个从未用过的新面孔塞进采样窗口
    function sampleWithExplore(g, why) {
      const base = [g[0], g[1]].filter(Boolean);
      const unused = g.filter(e => { const h = state.historyByEntryId[e.id]; return !(h && h.calls > 0); });
      let third = g[2] || null;
      if (unused.length && Math.random() < 0.34) {
        third = unused[Math.floor(Math.random() * unused.length)];
      }
      if (third && !base.includes(third)) base.push(third);
      return tsPick(base, why) || g[0];
    }

    // Phase 5：同质量切换——tier S/A/B/C 阶梯，同级优先，逐级下降，最后才考虑升级
    function tierRank(e) {
      const m = { S: 0, A: 1, B: 2, C: 3 };
      const r = m[String(e.tier || '').toUpperCase()];
      return r == null ? 2 : r;
    }
    function pickAlt(curEntry, excludeProvider) {
      const excludeId = curEntry ? curEntry.id : '';
      const now = Date.now();
      const cands = (pool.entries || []).filter(e => e.id !== excludeId && !e.disabled && !e.paid && !(e._cool > now)
        && !(e.cooldownUntil && Date.parse(e.cooldownUntil) > now)
        && !(provCool[splitId(e.id)[0]] > now)
        && !congested(e.id));
      if (!cands.length) return null;
      const cr = curEntry ? tierRank(curEntry) : 2;
      const order = [];
      for (let d = 0; d <= 3; d++) order.push(cr + d);
      for (let d = 3; d >= 1; d--) { const r = cr - d; if (r >= 0) order.push(r); }
      for (const r of order) {
        if (r < 0 || r > 3) continue;
        const g = cands.filter(e => tierRank(e) === r);
        if (!g.length) continue;
        g.sort((a, b) => urg(a) - urg(b));
        const chosen = sampleWithExplore(g, 'pickAlt:T' + 'SABC'[r]);
        if (chosen) return chosen;
      }
      return null;
    }

    // ---- accounting ----
    const bumpCell = (entryId) => {
      const m = (state.hourly[entryId] = state.hourly[entryId] || {});
      const k = dayHourKey();
      return (m[k] = m[k] || { ok: 0, fail: 0, error: 0 });
    };
    const recordStreamEnd = async (entryId, acc, durMs, errKind) => {
      const h = (state.historyByEntryId[entryId] = state.historyByEntryId[entryId] || {
        calls: 0, ok: 0, fail: 0, error: 0, lastStatus: null, lastAt: null,
      });
      h.calls++;
      if (errKind === 'ok') { h.ok++; const _ps = softStrikes[splitId(entryId)[0]]; if (_ps) _ps.n = 0; }
      else if (errKind === 'fail') h.fail++;
      else if (errKind === 'error') h.error++;
      else if (errKind === 'abort') h.abort = (h.abort || 0) + 1;
      h.lastStatus = errKind === 'abort' ? 'abort' : errKind;
      h.lastAt = new Date().toISOString();
      const cell = bumpCell(entryId);
      if (errKind === 'ok') cell.ok++; else if (errKind === 'fail') cell.fail++; else if (errKind === 'error') cell.error++;
      if (acc.ttft != null) {
        cell.ttftSum = (cell.ttftSum || 0) + acc.ttft;
        cell.ttftN = (cell.ttftN || 0) + 1;
        h.ttftEmaMs = h.ttftEmaMs == null ? acc.ttft : Math.round(h.ttftEmaMs * 0.7 + acc.ttft * 0.3);
      }
      if (acc.textChars) { cell.textChars = (cell.textChars || 0) + acc.textChars; h.textCharsTotal = (h.textCharsTotal || 0) + acc.textChars; }
      if (acc.reasonChars) { cell.reasonChars = (cell.reasonChars || 0) + acc.reasonChars; h.reasonCharsTotal = (h.reasonCharsTotal || 0) + acc.reasonChars; }
      if (acc.usage) {
        cell.tokIn = (cell.tokIn || 0) + (acc.usage.in || 0);
        cell.tokOut = (cell.tokOut || 0) + (acc.usage.out || 0);
        h.tokInTotal = (h.tokInTotal || 0) + (acc.usage.in || 0);
        h.tokOutTotal = (h.tokOutTotal || 0) + (acc.usage.out || 0);
        if (acc.usage.reasoning) h.tokReasonTotal = (h.tokReasonTotal || 0) + acc.usage.reasoning;
        h.lastUsage = acc.usage;
      }
      // Phase 4：付费模型按价记账（日累计，跨日自动清零）
      const pe = (pool.entries || []).find(x => x.id === entryId);
      if (pe && pe.paid && acc.usage && (acc.usage.in || acc.usage.out)) {
        const dayKey = new Date().toISOString().slice(0, 10);
        const pd = (state.paidSpend = state.paidSpend || {});
        const rec = (pd[entryId] = pd[entryId] || { dayKey: '', spendYuan: 0 });
        if (rec.dayKey !== dayKey) { rec.dayKey = dayKey; rec.spendYuan = 0; }
        const pin = Number(pe.priceInYuanPerM) || 0;
        const pout = Number(pe.priceOutYuanPerM) || 0;
        const cost = (acc.usage.in || 0) / 1e6 * pin + ((acc.usage.out || 0) + (acc.usage.reasoning || 0)) / 1e6 * pout;
        rec.spendYuan += cost;
        probeLog('paid ' + entryId + ' +¥' + cost.toFixed(4) + ' → 今日 ¥' + rec.spendYuan.toFixed(3));
        const cap = capOf(pe);
        if (Number.isFinite(cap) && rec.spendYuan >= cap * 0.5) {
          notifyOnce('half-' + entryId, '💰穷鬼路由器：' + entryId + ' 今日消费 ¥' + rec.spendYuan.toFixed(2) + ' 已过半（上限¥' + cap + '）');
        }
      }
      state.historySeq = (state.historySeq || 0) + 1;
      state.historyRing.push({ seq: state.historySeq, entryId, outcome: errKind, ttftMs: acc.ttft, at: h.lastAt });
      if (state.historyRing.length > 50) state.historyRing = state.historyRing.slice(-50);
      probe.metricsCaptured++;
      if (_seq++ % 3 === 0) await persist();
    };

    const findEntryPM = (provider, model) => {
      if (!pool.entries) return null;
      const full = provider ? provider + '/' + model : model;
      return pool.entries.find(e => e.id === full)
        || pool.entries.find(e => e.providerModel === full)
        || (model ? pool.entries.find(e => e.id.endsWith('/' + model)) : null)
        || (model ? pool.entries.find(e => e.id.split('/').pop() === String(model).split('/').pop()) : null)
        || null;
    };

    // ---- 幂等历史导入 ----
    const mergeImport = async () => {
      let impTarget = null;
      try { impTarget = await fs.resolve(IMPORT_PATH); } catch (e) { return; }
      if (!impTarget) return;
      const imp = await readJson(impTarget, null);
      if (!imp || !imp.byEntry || imp.consumed) return;
      if (state.importedAt && state.importedAt === imp.generatedAt) return;
      const inPool = (id) => !!(pool.entries && pool.entries.some(e => e.id === id));
      for (const [id, s] of Object.entries(imp.byEntry)) {
        if (!inPool(id)) continue;
        const h = (state.historyByEntryId[id] = state.historyByEntryId[id] || { calls: 0, ok: 0, fail: 0, error: 0, lastStatus: null, lastAt: null });
        h.calls += s.calls || 0; h.ok += s.ok || 0; h.fail += s.fail || 0;
      }
      for (const [id, hours] of Object.entries(imp.hourly || {})) {
        if (!inPool(id)) continue;
        const m = (state.hourly[id] = state.hourly[id] || {});
        for (const [hour, cell] of Object.entries(hours)) {
          const c = (m[hour] = m[hour] || { ok: 0, fail: 0, error: 0 });
          c.ok += cell.ok || 0; c.fail += cell.fail || 0;
        }
      }
      state.importedAt = imp.generatedAt || new Date().toISOString();
      probe.importedRequests = imp.requests || 0;
      probeLog('merged import requests=' + (imp.requests || 0));
      await persist();
      await writeJson(impTarget, { consumed: true, consumedAt: new Date().toISOString(), requests: imp.requests || 0 });
    };

    // ---- 钩子1：llm/stream ----
    ctx.on('llm/stream', (options, next) => {
      probe.streamFired++;
      const t0 = Date.now();
      let entry = null;
      try {
        entry = findEntryPM(options.provider, options.model);
        if (!entry && options.provider && options.model) {
          // 自动注册：首次出现的 provider/model 立即入池并记账
          const nid = options.provider + '/' + options.model;
          let dup = null;
          for (const e of (pool.entries || [])) { if (e.id === nid) { dup = e; break; } }
          if (!dup) {
            dup = { id: nid, provider: String(options.provider), model: String(options.model), tier: '?', unit: 'requests', grant: null, status: 'enabled', chains: ['main'], paid: false, autoAdded: true };
            dup.layer = layerOf(dup);
            pool.entries.push(dup);
            probe.autoRegistered = (probe.autoRegistered || 0) + 1;
            probeLog('auto-registered ' + nid);
            writeJson(poolTarget, pool);
          }
          entry = dup;
        }
        if (entry) {
          lastEntryByProvider[options.provider] = entry.id;
          entry._probe = entry._probe || {};
          entry._probe.streamFired = (entry._probe.streamFired || 0) + 1;

          if (ROUTE.enabled && pool.entries) {
            const curLayer = layerOf(entry);
            const aux = !!options.purpose;
            const simple = !options.tools && estimateTokens(options) < 4000;
            if (aux || simple) {
              // 强规划弱执行：额度最厚者优先；每第6笔探索一个冷门免费模型
              const p = pickAuxTarget();
              if (p && p.target && p.target.id !== entry.id) {
                swap(options, p.target, p.why || (aux ? 'aux-downgrade' : 'simple-downgrade'));
                entry = p.target;
              }
            }
            if (provCool[options.provider] > Date.now()) {
              const alt = resolveAlt(entry, options.provider);
              if (alt) { swap(options, alt, 'provider-cooling'); entry = alt; }
            } else
            if (coolingEntry(entry)) {
              const alt = resolveAlt(entry);
              if (alt) { swap(options, alt, 'model-cooling'); entry = alt; }
            } else
            if (ADAPTIVE.enabled && congested(entry.id)) {
              const alt = resolveAlt(entry);
              if (alt) { swap(options, alt, 'hour-congested'); entry = alt; }
            }
          }
          if (options.reasoningEffort != null) {
            const h2 = (state.historyByEntryId[entry.id] = state.historyByEntryId[entry.id] || { calls: 0, ok: 0, fail: 0, error: 0, lastStatus: null, lastAt: null });
            h2.lastEffort = String(options.reasoningEffort);
            const seen = (h2.effortsSeen = h2.effortsSeen || []);
            if (!seen.includes(h2.lastEffort) && seen.length < 8) seen.push(h2.lastEffort);
          }
          probe.lastStream = { id: entry.id, at: new Date().toISOString(), proposed: options.provider + '/' + options.model };
        } else {
          probe.lastUnmatched = { proposed: options.provider + '/' + options.model, at: new Date().toISOString() };
        }
      } catch (e) { log('observe stream error', e && e.message); }

      const id = entry ? entry.id : null;
      let raw;
      try { raw = next(); }
      catch (e) {
        if (id) recordStreamEnd(id, {}, Date.now() - t0, 'fail').catch(() => {});
        throw e;
      }

      const acc = { ttft: null, ttftText: null, textChars: 0, reasonChars: 0, usage: null, finishReason: null };
      async function* wrap() {
        try {
          for await (const c of raw) {
            if (acc.ttft == null) acc.ttft = Date.now() - t0;
            if (c && c.type === 'text-delta') {
              if (acc.ttftText == null) acc.ttftText = Date.now() - t0;
              acc.textChars += (c.text || '').length;
            } else if (c && c.type === 'reasoning-delta') {
              acc.reasonChars += (c.text || '').length;
            } else if (c && c.type === 'usage' && c.usage) {
              acc.usage = { in: c.usage.inputTokens || 0, out: c.usage.outputTokens || 0, reasoning: c.usage.reasoningTokens, cacheRead: c.usage.cacheReadTokens, cacheWrite: c.usage.cacheWriteTokens };
            } else if (c && c.type === 'finish') {
              acc.finishReason = String(c.reason || '');
            }
            yield c;
          }
          const kind = acc.finishReason === 'error' ? 'fail'
            : acc.finishReason === 'aborted' ? 'abort' : 'ok';
          if (id) recordStreamEnd(id, acc, Date.now() - t0, kind).catch(e => log('metric rec fail', e && e.message));
        } catch (e) {
          const aborted = (e && (e.name === 'AbortError' || /abort/i.test(String(e && e.message)))) || (options.signal && options.signal.aborted);
          if (id) recordStreamEnd(id, acc, Date.now() - t0, aborted ? 'abort' : 'fail').catch(() => {});
          throw e;
        }
      }
      return wrap();
    });

    // ---- 钩子2：agent/request ----
    ctx.on('agent/request', (payload, next) => {
      probe.requestFired++;
      const result = next();
      return Promise.resolve(result).then(config => {
        try {
          probe.lastRequest = { providerModel: config.provider + '/' + config.model, at: new Date().toISOString() };
          const e = findEntryPM(config.provider, config.model);
          if (e) {
            e._probe = e._probe || {};
            e._probe.requestFired = (e._probe.requestFired || 0) + 1;
          }
          if (ROUTE.enabled && provCool[config.provider] > Date.now()) {
            const cur = e || null;
            const alt = resolveAlt(cur, config.provider);
            if (alt) {
              const parts = splitId(alt.id);
              logSwitch(config.provider + '/' + config.model, alt.id, 'request-provider-cooling');
              ROUTE.routedIn++;
              return { ...config, provider: parts[0], model: parts[1] };
            }
          }
        } catch (e) { log('request hook error', e && e.message); }
        return config;
      });
    });

    // ---- 钩子3：agent/request-error ----
    ctx.on('agent/request-error', (payload, next) => {
      probe.errorFired++;
      try {
        const f = payload.failure || {};
        const sig = String(f.code || f.status || (f.error && f.error.code) || f.name || f.message || '');
        probe.lastError = { sig: sig.slice(0, 140), provider: payload.provider, turn: payload.turn, step: payload.step, at: new Date().toISOString() };
        const HARD = /(AUTH|UNAUTHORIZED|FORBIDDEN|PERMISSION|NOT_FOUND|INSUFFICIENT|QUOTA|BALANCE|CREDIT|INVALID_API_KEY)/i;
        const RATE = /(RATE|LIMIT|429)/i;
        if (HARD.test(sig)) {
          provCool[payload.provider] = Date.now() + 10 * 60000;
          state.provCool = state.provCool || {};
          state.provCool[payload.provider] = provCool[payload.provider];
          probeLog('HARD fail ' + payload.provider + ' → cool 10m :: ' + sig.slice(0, 60));
        } else if (RATE.test(sig)) {
          const until = Math.max(provCool[payload.provider] || 0, Date.now() + 90 * 1000);
          provCool[payload.provider] = until;
          state.provCool = state.provCool || {};
          state.provCool[payload.provider] = until;
          probeLog('rate-limit ' + payload.provider + ' → cool 90s');
        } else {
          // 软错误快速熔断：首次30s，10分钟内连击指数升级（封顶5min），成功一次清零
          const st = (softStrikes[payload.provider] = softStrikes[payload.provider] || { n: 0, at: 0 });
          st.n = (Date.now() - st.at < 600000) ? st.n + 1 : 1;
          st.at = Date.now();
          const coolMs = Math.min(30000 * Math.pow(2, st.n - 1), 300000);
          const untilS = Math.max(provCool[payload.provider] || 0, Date.now() + coolMs);
          provCool[payload.provider] = untilS;
          state.provCool = state.provCool || {};
          state.provCool[payload.provider] = untilS;
          probeLog('soft fail ' + payload.provider + ' x' + st.n + ' → cool ' + Math.round(coolMs / 1000) + 's :: ' + sig.slice(0, 60));
        }
      } catch (e) { log('error hook failure', e && e.message); }
      return next();
    });

    ctx.effect(() => {
      ensure()
        .then(async () => {
          let dirty = false;
          for (const e of pool.entries || []) {
            const L = layerOf(e);
            if (e.layer !== L) { e.layer = L; dirty = true; }
          }
          if (dirty) await writeJson(poolTarget, pool);
          await mergeImport();
          // 口径归一化：calls = ok+fail+error+abort（修正历史导入把 retry 记成 fail 的口径）
          if (!state.normalizedAt) {
            let fixed = 0;
            for (const h of Object.values(state.historyByEntryId)) {
              const s = (h.ok || 0) + (h.fail || 0) + (h.error || 0) + (h.abort || 0);
              if ((h.calls || 0) !== s) { h.calls = s; fixed++; }
            }
            state.normalizedAt = new Date().toISOString();
            probeLog('normalized calls identity on ' + fixed + ' entries');
            await persist();
          }
          // Phase 7：时段桶v2迁移（A1）——旧格式纯小时键无法归属日期，一次性清除
          if (!state.hourlyV2At) {
            let dropped = 0;
            for (const id of Object.keys(state.hourly)) {
              const m = state.hourly[id];
              for (const k of Object.keys(m)) {
                if (!/^\d{4}-\d{2}-\d{2}:/.test(k)) { delete m[k]; dropped++; }
              }
              if (Object.keys(m).length === 0) delete state.hourly[id];
            }
            state.hourlyV2At = new Date().toISOString();
            probeLog('hourly v2 migration done, dropped=' + dropped);
          }
          // Phase 7：7天滚动清理（A1）
          {
            const cut = new Date(Date.now() - 7 * 86400000);
            const cutoff = cut.getFullYear() + '-' + String(cut.getMonth() + 1).padStart(2, '0') + '-' + String(cut.getDate()).padStart(2, '0');
            let pruned = 0;
            for (const id of Object.keys(state.hourly)) {
              const m = state.hourly[id];
              for (const k of Object.keys(m)) {
                const ds = k.slice(0, 10);
                if (/^\d{4}-\d{2}-\d{2}$/.test(ds) && ds < cutoff) { delete m[k]; pruned++; }
              }
              if (Object.keys(m).length === 0) delete state.hourly[id];
            }
            if (pruned > 0) probeLog('pruned ' + pruned + ' stale hourly cells (< ' + cutoff + ')');
          }
          probeLog('init done; routing=' + (ROUTE.enabled ? 'ON' : 'OFF'));
        })
        .catch(e => { log('init error', e && e.message); });
    });

    let statusExec = null;
    let controlExec = null;

    // ---- tool: pool_status ----
    {
      const def = {
        name: 'pool_status',
        description: 'Full snapshot of the poor-router pool.',
        parameters: { type: 'object', properties: {} },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
          properties: {
            summary: {
              type: 'object',
              additionalProperties: false,
              properties: {
                loaded: { type: 'integer' },
                healthyCount: { type: 'integer' },
                routingEnabled: { type: 'boolean' },
                adaptiveEnabled: { type: 'boolean' },
                routedAway: { type: 'integer' },
                routedIn: { type: 'integer' },
                metricsCaptured: { type: 'integer' },
                autoRegistered: { type: 'integer' },
                badgeEnabled: { type: 'boolean' },
                paidAllowed: { type: 'boolean' },
                recentPicks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, v: { type: 'number' }, why: { type: 'string' } } } },
                lastPickStats: { type: 'object', additionalProperties: false, properties: { why: { type: 'string' }, winner: { type: 'string' }, stats: { type: 'object', additionalProperties: false, properties: { ok: { type: 'integer' }, fail: { type: 'integer' }, n: { type: 'integer' }, ttftAvg: { type: 'integer' } } } } },
                providerCooldowns: { type: 'array', items: { type: 'string' } },
                persistWrites: { type: 'integer' },
                persistErrors: { type: 'integer' },
                init: { type: 'string' },
                importedRequests: { type: 'integer' },
                hourlyTrackedEntries: { type: 'integer' },
                rank: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, layer: { type: 'string' }, score: { type: 'number' }, okRate: { type: 'number' }, n: { type: 'integer' }, ttftMs: { type: 'integer' } } } },
                paidSpend: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, spendYuan: { type: 'number' }, capYuan: { type: 'number' } } } },
                probe: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    streamFired: { type: 'integer' },
                    requestFired: { type: 'integer' },
                    errorFired: { type: 'integer' },
                    persistOk: { type: 'integer' },
                    persistFail: { type: 'integer' },
                    paidEscapes: { type: 'integer' },
                    blockedEscapes: { type: 'integer' },
                    auxExplores: { type: 'integer' },
                    fsApi: { type: 'string' },
                    persistLog: { type: 'array', items: { type: 'string' } },
                    lastStream: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, at: { type: 'string' }, proposed: { type: 'string' } } },
                    lastRequest: { type: 'object', additionalProperties: false, properties: { providerModel: { type: 'string' }, at: { type: 'string' } } },
                    lastSwitch: { type: 'object', additionalProperties: false, properties: { from: { type: 'string' }, to: { type: 'string' }, why: { type: 'string' }, at: { type: 'string' } } },
                    recentSwitches: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { from: { type: 'string' }, to: { type: 'string' }, why: { type: 'string' }, at: { type: 'string' } } } },
                    lastError: { type: 'object', additionalProperties: false, properties: { sig: { type: 'string' }, provider: { type: 'string' }, turn: { type: 'integer' }, step: { type: 'integer' }, at: { type: 'string' } } },
                  },
                },
              },
            },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  provider: { type: 'string' },
                  model: { type: 'string' },
                  layer: { type: 'string' },
                  healthy: { type: 'boolean' },
                  expiresAt: { type: 'string' },
                  grantRemaining: { type: 'number' },
                  grantUnit: { type: 'string' },
                  tier: { type: 'string' },
                  role: { type: 'string' },
                  calls: { type: 'integer' },
                  ok: { type: 'integer' },
                  fail: { type: 'integer' },
                  error: { type: 'integer' },
                  abort: { type: 'integer' },
                  lastStatus: { type: 'string' },
                  lastAt: { type: 'string' },
                  streamFired: { type: 'integer' },
                  requestFired: { type: 'integer' },
                  avgTtftMs: { type: 'integer' },
                  tokInTotal: { type: 'integer' },
                  tokOutTotal: { type: 'integer' },
                  tokReasonTotal: { type: 'integer' },
                  lastUsageIn: { type: 'integer' },
                  lastUsageOut: { type: 'integer' },
                  lastEffort: { type: 'string' },
                  hourlyOk: { type: 'integer' },
                  hourlyFail: { type: 'integer' },
                },
              },
            },
            poolPath: { type: 'string' },
            statePath: { type: 'string' },
          },
          },
          render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async () => {
          await ensure();
          const history = state.historyByEntryId || {};
          const now = Date.now();
          const entries = (pool.entries || []).map(e => {
            const h = history[e.id];
            const pr = e._probe || {};
            const hm = state.hourly[e.id];
            let hourlyOk = 0, hourlyFail = 0;
            if (hm) for (const c of Object.values(hm)) { hourlyOk += c.ok || 0; hourlyFail += c.fail || 0; }
            const item = {
              id: e.id,
              provider: e.provider,
              healthy: !!e.healthy,
              calls: h ? h.calls : 0,
              ok: h ? h.ok : 0,
              fail: h ? h.fail : 0,
              error: h ? h.error : 0,
              abort: h ? (h.abort || 0) : 0,
              hourlyOk,
              hourlyFail,
            };
            item.layer = layerOf(e);
            item.streamFired = pr.streamFired || 0;
            item.requestFired = pr.requestFired || 0;
            if (e.model != null) item.model = e.model;
            if (e.expiresAt != null) item.expiresAt = e.expiresAt;
            if (e.grantRemaining != null) item.grantRemaining = e.grantRemaining;
            if (e.grantUnit != null) item.grantUnit = e.grantUnit;
            if (e.tier != null) item.tier = String(e.tier);
            if (e.role != null) item.role = String(e.role);
            if (h && h.lastStatus != null) item.lastStatus = h.lastStatus;
            if (h && h.lastAt != null) item.lastAt = h.lastAt;
            if (h && h.ttftEmaMs != null) item.avgTtftMs = h.ttftEmaMs;
            if (h && h.tokInTotal) item.tokInTotal = h.tokInTotal;
            if (h && h.tokOutTotal) item.tokOutTotal = h.tokOutTotal;
            if (h && h.tokReasonTotal) item.tokReasonTotal = h.tokReasonTotal;
            if (h && h.lastUsage) {
              item.lastUsageIn = h.lastUsage.in || 0;
              item.lastUsageOut = h.lastUsage.out || 0;
            }
            if (h && h.lastEffort != null) item.lastEffort = h.lastEffort;
            return item;
          });
          // 排行榜：确定性后验均值 × TTFF 惩罚，剔除禁用/冷却中
          const rank = [];
          for (const e of (pool.entries || [])) {
            if (e.disabled) continue;
            if ((e._cool || 0) > now) continue;
            if (e.cooldownUntil && Date.parse(e.cooldownUntil) > now) continue;
            if (provCool[splitId(e.id)[0]] > now) continue;
            const h = history[e.id];
            if (!h) continue;
            const n = (h.ok || 0) + (h.fail || 0) + (h.error || 0);
            if (n < 1) continue;
            const mean = (h.ok + 1) / (n + 2);
            let lat = 1;
            const tt = h.ttftEmaMs;
            if (tt != null && tt > 3000) lat = Math.max(0.5, 3000 / tt);
            const rItem = { id: e.id, layer: layerOf(e), score: Math.round(mean * lat * 1000) / 1000, n };
            rItem.okRate = Math.round((h.ok / n) * 100) / 100;
            if (tt != null) rItem.ttftMs = tt;
            rank.push(rItem);
          }
          rank.sort((a, b) => b.score - a.score);
          const topRank = rank.slice(0, 8);
          const cools = Object.entries(provCool).filter(([, t]) => t > now)
            .map(([p, t]) => p + ' until ' + new Date(t).toISOString());
          // Phase 4：真钱面板数据
          const dayKey = new Date().toISOString().slice(0, 10);
          const paidRows = [];
          for (const e of (pool.entries || [])) {
            if (!e.paid) continue;
            const spend = paidSpendToday(e.id);
            const row = { id: e.id, spendYuan: Math.round(spend * 10000) / 10000 };
            if (Number.isFinite(capOf(e))) row.capYuan = capOf(e);
            paidRows.push(row);
          }
          return {
            summary: {
              loaded: entries.length,
              healthyCount: entries.filter(x => x.healthy).length,
              routingEnabled: !!ROUTE.enabled,
              adaptiveEnabled: !!ADAPTIVE.enabled,
              routedAway: ROUTE.routedAway,
              routedIn: ROUTE.routedIn,
              metricsCaptured: probe.metricsCaptured,
              autoRegistered: probe.autoRegistered || 0,
              badgeEnabled: !(state.ui && state.ui.badge === false),
              paidAllowed: !!(state.ui && state.ui.paidAllowed === true),
              ...(topRank.length ? { rank: topRank } : {}),
              ...(paidRows.length ? { paidSpend: paidRows } : {}),
              ...(ADAPTIVE.picks.length ? { recentPicks: ADAPTIVE.picks.slice(-8) } : {}),
              ...(probe.lastPickStats ? { lastPickStats: probe.lastPickStats } : {}),
              ...(cools.length ? { providerCooldowns: cools } : {}),
              persistWrites: probe.persistOk,
              persistErrors: state._persistErrors || 0,
              init: probe.init || 'unknown',
              ...(probe.importedRequests != null ? { importedRequests: probe.importedRequests } : {}),
              hourlyTrackedEntries: Object.keys(state.hourly).length,
              probe: {
                streamFired: probe.streamFired,
                requestFired: probe.requestFired,
                errorFired: probe.errorFired,
                persistOk: probe.persistOk,
                persistFail: probe.persistFail,
                paidEscapes: probe.paidEscapes || 0,
                blockedEscapes: probe.blockedEscapes || 0,
                auxExplores: probe.auxExplores || 0,
                fsApi: probe.fsApi,
                persistLog: probe.persistLog.slice(-15),
                ...(probe.lastStream ? { lastStream: probe.lastStream } : {}),
                ...(probe.lastRequest ? { lastRequest: probe.lastRequest } : {}),
                ...(probe.lastSwitch ? { lastSwitch: probe.lastSwitch } : {}),
                ...(state.switchLog && state.switchLog.length ? { recentSwitches: state.switchLog.slice(-10) } : {}),
                ...(probe.lastError ? { lastError: probe.lastError } : {}),
              },
            },
            entries,
            poolPath: POOL_PATH,
            statePath: STATE_PATH,
          };
        },
      };
      ctx.effect(() => ctx.tools.register(def, 'poor-router.tool.pool_status'))
      statusExec = def.execute;
    }

    // ---- tool: pool_control ----
    {
      const def = {
        name: 'pool_control',
        description: 'Manual overrides and routing kill-switches for poor-router.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['setHealthy', 'setUnhealthy', 'setExpiry', 'setGrant', 'setCooldown', 'resetCounters', 'setDisabled', 'setEnabled', 'setRouting', 'setAdaptive', 'setBadge', 'setTier', 'setPaidAllowed', 'clearProviderCooldown', 'reloadPool'],
            },
            id: { type: 'string' },
            value: {
              type: 'object',
              additionalProperties: false,
              properties: {
                expiresAt: { type: 'string' },
                grantRemaining: { type: 'number' },
                grantUnit: { type: 'string' },
                cooldownUntil: { type: 'string' },
                enabled: { type: 'boolean' },
                allowed: { type: 'boolean' },
                tier: { type: 'string', enum: ['S', 'A', 'B', 'C'] },
                layer: { type: 'string', enum: ['backbone', 'burn', 'matchstick'] },
              },
            },
          },
          required: ['action', 'id'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            calls: { type: 'integer' },
            routingEnabled: { type: 'boolean' },
          },
          },
          render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args) => {
          if (args.action === 'setRouting') {
            ROUTE.enabled = !!(args.value && args.value.enabled);
            probeLog('routing ' + (ROUTE.enabled ? 'ENABLED' : 'DISABLED'));
            await persist();
            return { ok: true, message: 'routing ' + (ROUTE.enabled ? 'enabled' : 'disabled'), routingEnabled: ROUTE.enabled };
          }
          if (args.action === 'clearProviderCooldown') {
            delete provCool[args.id];
            if (state.provCool) delete state.provCool[args.id];
            probeLog('cleared cooldown for provider ' + args.id);
            return { ok: true, message: 'cooldown cleared for ' + args.id };
          }
          if (args.action === 'setAdaptive') {
            ADAPTIVE.enabled = !!(args.value && args.value.enabled);
            probeLog('adaptive ' + (ADAPTIVE.enabled ? 'ENABLED' : 'DISABLED'));
            return { ok: true, message: 'adaptive ' + (ADAPTIVE.enabled ? 'enabled' : 'disabled') };
          }
          if (args.action === 'setBadge') {
            const on = !!(args.value && args.value.enabled);
            state.ui = state.ui || {};
            state.ui.badge = on;
            probeLog('badge ' + (on ? 'ON' : 'OFF'));
            await persist();
            return { ok: true, message: 'badge ' + (on ? 'shown' : 'hidden'), routingEnabled: ROUTE.enabled };
          }
          if (args.action === 'setPaidAllowed') {
            const on = !!(args.value && args.value.allowed);
            state.ui = state.ui || {};
            state.ui.paidAllowed = on;
            probeLog('paid escape ' + (on ? '✅ AUTHORIZED by user' : '⛔ FORBIDDEN'));
            await persist();
            return { ok: true, message: 'paid escape ' + (on ? 'authorized' : 'forbidden') };
          }
          if (args.action === 'setTier') {
            const t = String(args.value && args.value.tier ? args.value.tier : '').toUpperCase();
            if (t.length !== 1 || 'SABC'.indexOf(t) < 0) return { ok: false, message: 'tier must be S/A/B/C' };
            const entry = pool.entries && pool.entries.find(e => e.id === args.id);
            if (!entry) return { ok: false, message: 'entry not found: ' + args.id };
            entry.tier = t;
            probeLog('tier ' + entry.id + ' → ' + t + ' (manual)');
            await writeJson(poolTarget, pool);
            return { ok: true, message: entry.id + ' tier → ' + t };
          }
          if (args.action === 'reloadPool') {
            const fresh = await readJson(poolTarget, null);
            if (!fresh || !fresh.entries) return { ok: false, message: 'pool reload failed' };
            pool = fresh;
            for (const e of pool.entries || []) { e.layer = layerOf(e); }
            probeLog('pool reloaded: ' + (pool.entries ? pool.entries.length : 0) + ' entries');
            return { ok: true, message: 'reloaded ' + (pool.entries ? pool.entries.length : 0) + ' entries' };
          }
          const entry = pool.entries && pool.entries.find(e => e.id === args.id);
          if (!entry) return { ok: false, message: 'entry not found: ' + args.id };
          switch (args.action) {
            case 'setHealthy': entry.healthy = true; entry.healthyAt = new Date().toISOString(); entry.consecutiveFailures = 0; entry._cool = 0; break;
            case 'setUnhealthy': entry.healthy = false; entry.unhealthyAt = new Date().toISOString(); break;
            case 'setExpiry': entry.expiresAt = args.value && args.value.expiresAt ? args.value.expiresAt : null; break;
            case 'setGrant':
              entry.grantRemaining = args.value && args.value.grantRemaining != null ? args.value.grantRemaining : null;
              entry.grantUnit = args.value && args.value.grantUnit ? args.value.grantUnit : null;
              break;
            case 'setCooldown': entry.cooldownUntil = args.value && args.value.cooldownUntil ? args.value.cooldownUntil : new Date(Date.now() + 60000).toISOString(); break;
            case 'resetCounters': {
              const h = state.historyByEntryId[entry.id];
              if (h) { h.calls = 0; h.ok = 0; h.fail = 0; h.error = 0; h.abort = 0; h.lastStatus = null; h.lastAt = null; }
              break;
            }
            case 'setDisabled': entry.disabled = true; break;
            case 'setEnabled': entry.disabled = false; break;
            default: return { ok: false, message: 'unknown action: ' + args.action };
          }
          await writeJson(poolTarget, pool);
          await persist();
          const h = state.historyByEntryId[entry.id];
          return { ok: true, message: entry.id + ' ' + args.action + ' done', calls: h ? h.calls : 0 };
        },
      };
      ctx.effect(() => ctx.tools.register(def, 'poor-router.tool.pool_control'))
      controlExec = def.execute;
    }

    // ---- HTTP API（Web 面板数据通道；动态插件的 harness RPC 在此换成 webServer 路由）----
    const sendJson = (res, code, obj) => {
      try {
        const body = JSON.stringify(obj)
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
      } catch (e) { /* 客户端断开 */ }
    }
    const readJsonBody = (req) => new Promise((resolve) => {
      let raw = ''
      req.on('data', (c) => { raw += c; if (raw.length > 1048576) raw = '' })
      req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch (e) { resolve({}) } })
      req.on('error', () => resolve({}))
    })
    const endpoints = {
      snapshot: async () => (statusExec ? statusExec() : { error: 'snapshot unavailable' }),
      control: async (args) => (controlExec ? controlExec(args || {}) : { ok: false, message: 'control unavailable' }),
      routeState: async (args) => {
        const badgeOn = () => !(state.ui && state.ui.badge === false)
        const since = args && args.since ? String(args.since) : null
        const deadline = Date.now() + 4500
        let n = 0
        let cur = ROUTE.switches.length ? ROUTE.switches[ROUTE.switches.length - 1] : null
        if (!cur && !since) {
          return { routingEnabled: !!ROUTE.enabled, adaptiveEnabled: !!ADAPTIVE.enabled, badge: badgeOn() }
        }
        while (n < 900 && Date.now() < deadline) {
          cur = ROUTE.switches.length ? ROUTE.switches[ROUTE.switches.length - 1] : null
          const at = cur ? cur.at : null
          if ((at && at !== since) || (!cur && since)) break
          try { await fs.readText(stateTarget); } catch (e2) { break; }
          n++
        }
        return {
          routingEnabled: !!ROUTE.enabled,
          adaptiveEnabled: !!ADAPTIVE.enabled,
          badge: badgeOn(),
          ...(cur ? { lastSwitch: cur } : {}),
        }
      },
    }
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/api/poor-router',
      handler: async (req, res) => {
        const path = (req.url || '').split('?')[0]
        const epName = path.replace(/^\/api\/poor-router\/?/, '').split('/')[0]
        const ep = endpoints[epName]
        if (!ep) { sendJson(res, 404, { ok: false, message: 'unknown endpoint: ' + epName }); return }
        try {
          const args = await readJsonBody(req)
          sendJson(res, 200, await ep(args))
        } catch (error) {
          sendJson(res, 200, { ok: false, message: String((error && error.message) || error) })
        }
      },
    }))
    const rpcOff = []
    log('poor-router v23 applied; routing=' + (ROUTE.enabled ? 'ON' : 'OFF') + '; adaptive=TS; paid-gate=CONSENT-ONLY(default-block); soft-fuse=30s~5min-escalating; pickAlt-provfix=ON; tier-ladder=S>A>B>C(manual); aux-explore=1/6; ttft-gate=30s; text-me=ON; badge-toggle=ON; hourly-v2+7d-prune=ON; switch-log=50; provcool-persist=ON');
    return () => {
      for (const d of rpcOff) { try { if (typeof d === 'function') d(); } catch (e) { /* noop */ } }
      return persist().then(() => { log('plugin disposed, state persisted'); });
    };
}
