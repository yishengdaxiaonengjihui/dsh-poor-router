/**
 * dsh-poor-router 客户端半 —— 设置页面板 + 输入框改道指示灯
 * 由 client-modules 打包为 /plugins/dsh-poor-router/client.js 注入页面；
 * factory 内 require("react") 由平台模块表提供。数据走 /api/poor-router/*。
 */
window.__ModuleLoader__.load({
  id: 'dsh-poor-router',
  factory: (require) => {
    const React = require('react')

    function api(name, args) {
      return fetch('/api/poor-router/' + name, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args || {}),
      }).then((r) => r.json())
    }

    return {
      name: 'dsh-poor-router',
      apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;
    const E = React.createElement;

    const LAYER_COLOR = { backbone: 'rgba(59,130,246,0.22)', burn: 'rgba(245,158,11,0.22)', matchstick: 'rgba(168,85,247,0.22)' };
    const LAYER_TEXT = { backbone: '骨干', burn: '消耗品', matchstick: '火柴盒' };
    const TIER_BG = { S: 'rgba(234,179,8,0.28)', A: 'rgba(59,130,246,0.22)', B: 'rgba(128,128,128,0.2)', C: 'rgba(168,85,247,0.22)' };
    const CARD = { background: 'rgba(128,128,128,0.07)', border: '1px solid rgba(128,128,128,0.22)', borderRadius: 10, padding: '8px 12px', marginBottom: 12 };
    const btn = { cursor: 'pointer', border: '1px solid rgba(128,128,128,0.4)', borderRadius: 7, padding: '3px 11px', fontSize: 12, background: 'transparent', color: 'inherit' };
    const chipS = { display: 'inline-block', padding: '2px 9px', marginRight: 8, marginBottom: 6, borderRadius: 6, border: '1px solid rgba(128,128,128,0.32)', fontSize: 12, fontVariantNumeric: 'tabular-nums' };
    const inpS = { background: 'rgba(128,128,128,0.08)', color: 'inherit', border: '1px solid rgba(128,128,128,0.45)', borderRadius: 6, padding: '3px 6px', fontSize: 12, fontVariantNumeric: 'tabular-nums', outline: 'none', colorScheme: 'dark' };
    const rowS = { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px', borderBottom: '1px solid rgba(128,128,128,0.14)', cursor: 'pointer', fontSize: 12 };
    const detS = { fontSize: 12, lineHeight: 1.9, padding: '6px 4px 2px 22px', opacity: 0.92 };

    const fmtK = (n) => (n == null ? '—' : n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n));
    const fmtT = (iso) => { try { return new Date(iso).toLocaleTimeString(); } catch (e) { return iso; } };
    const shortName = (id) => id.split('/').slice(1).join('/') || id;

    function Badge(text, bg) {
      return E('span', { style: { display: 'inline-block', padding: '1px 7px', borderRadius: 5, fontSize: 11, background: bg, flex: '0 0 auto' } }, text);
    }

    function RateBar(okN, n) {
      const pct = n ? Math.round((okN / n) * 100) : null;
      const col = pct == null ? 'rgba(128,128,128,0.4)' : pct >= 90 ? '#22c55e' : pct >= 60 ? '#f59e0b' : '#ef4444';
      return E('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
        E('span', { style: { width: 36, height: 5, borderRadius: 3, background: 'rgba(128,128,128,0.25)', overflow: 'hidden', display: 'inline-block' } },
          E('span', { style: { display: 'block', height: '100%', width: (pct == null ? 0 : pct) + '%', background: col } })),
        E('span', { style: { fontSize: 11 } }, pct == null ? '—' : pct + '%'));
    }

    function EditForm(props) {
      const en = props.en;
      const act = props.act;
      const initExp = en.expiresAt || '';
      const initG = en.grantRemaining != null ? String(en.grantRemaining) : '';
      const initU = en.grantUnit || '';
      const expSt = React.useState(initExp);
      const gSt = React.useState(initG);
      const uSt = React.useState(initU);
      const msgSt = React.useState('');
      const exp = expSt[0]; const setExp = expSt[1];
      const g = gSt[0]; const setG = gSt[1];
      const u = uSt[0]; const setU = uSt[1];
      const msg = msgSt[0]; const setMsg = msgSt[1];

      const save = function () {
        setMsg('保存中…');
        let p = Promise.resolve();
        if (exp !== initExp) {
          p = p.then(() => act('setExpiry', en.id, exp === '' ? { expiresAt: null } : { expiresAt: exp }));
        }
        const num = g.trim() === '' ? null : Number(g);
        const gChanged = String(num) !== String(initG) || u !== initU;
        if (gChanged && (num == null || !Number.isNaN(num))) {
          p = p.then(() => act('setGrant', en.id, { grantRemaining: num, grantUnit: u.trim() }));
        }
        p.then(() => setMsg('✓ 已保存')).catch((e) => setMsg('✗ ' + String((e && e.message) || e)));
      };

      const setTier = function (t) {
        setMsg('质量→' + t + '…');
        act('setTier', en.id, { tier: t })
          .then(() => setMsg('✓ 质量档=' + t))
          .catch((e) => setMsg('✗ ' + String((e && e.message) || e)));
      };

      return E('div', { style: Object.assign({}, detS, { borderTop: '1px dashed rgba(128,128,128,0.3)', marginTop: 4 }) },
        E('div', { style: { marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 } },
          E('label', { style: { marginRight: 2 } }, '质量档'),
          ['S', 'A', 'B', 'C'].map((t) => {
            const cur = String(en.tier || '').toUpperCase() === t;
            return E('button', {
              key: t,
              style: Object.assign({}, btn, { padding: '1px 9px', fontSize: 11, background: cur ? 'rgba(234,179,8,0.25)' : 'transparent', fontWeight: cur ? 700 : 400 }),
              onClick: () => setTier(t),
            }, t);
          })),
        E('div', { style: { marginBottom: 6 } },
          E('label', { style: { marginRight: 6 } }, '到期日'),
          E('input', { type: 'date', value: exp, style: Object.assign({}, inpS, { width: 140 }), onChange: (ev) => setExp(ev.target.value) }),
        ),
        E('div', { style: { marginBottom: 6 } },
          E('label', { style: { marginRight: 6 } }, '剩余用量'),
          E('input', { value: g, placeholder: '数量', style: Object.assign({}, inpS, { width: 80 }), onChange: (ev) => setG(ev.target.value) }),
          E('input', { value: u, placeholder: '单位', style: Object.assign({}, inpS, { width: 56, marginLeft: 4 }), onChange: (ev) => setU(ev.target.value) }),
        ),
        E('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
          E('button', { style: Object.assign({}, btn, { color: '#22c55e' }), onClick: save }, '保存修改'),
          E('span', { style: { fontSize: 11, opacity: 0.8 } }, msg),
        ),
      );
    }

    function Dashboard() {
      const snapState = React.useState(null);
      const snap = snapState[0]; const setSnap = snapState[1];
      const errState = React.useState(null);
      const err = errState[0]; const setErr = errState[1];
      const busyState = React.useState(false);
      const busy = busyState[0]; const setBusy = busyState[1];
      const openState = React.useState(null);
      const openId = openState[0]; const setOpenId = openState[1];

      const load = React.useCallback(() => {
        return api('snapshot')
          .then((r) => { setSnap(r); setErr(null); })
          .catch((e) => setErr(String((e && e.message) || e)));
      }, []);
      React.useEffect(() => { load(); }, [load]);

      const act = (action, id, value) => {
        const msg = { action, id };
        if (value !== undefined) msg.value = value;
        return api('control', msg)
          .then((r) => { load(); return r; })
          .catch((e) => { setErr(String((e && e.message) || e)); throw e; });
      };
      const withBusy = (fn) => {
        if (busy) return;
        setBusy(true);
        fn().then(() => setBusy(false)).catch(() => setBusy(false));
      };

      if (err && !snap) return E('div', { style: { padding: 12, color: '#ef4444' } }, '加载失败：' + err);
      if (!snap) return E('div', { style: { padding: 12, opacity: 0.6 } }, '加载中…');

      const sum = snap.summary || {};
      const entries = (snap.entries || []).slice().sort((a, b) => (b.calls || 0) - (a.calls || 0));
      const switches = (sum.probe && sum.probe.recentSwitches) || [];
      const picks = sum.recentPicks || [];
      const rank = sum.rank || [];

      const byProv = {};
      for (const en of entries) {
        const p = en.provider || '其他';
        if (!byProv[p]) byProv[p] = [];
        byProv[p].push(en);
      }
      const provs = Object.keys(byProv).sort((a, b) => {
        const sa = byProv[a].reduce((s, x) => s + (x.calls || 0), 0);
        const sb = byProv[b].reduce((s, x) => s + (x.calls || 0), 0);
        return sb - sa;
      });

      const MEDALS = ['🥇', '🥈', '🥉'];

      function entryLine(en) {
        const isOpen = openId === en.id;
        const nAll = (en.ok || 0) + (en.fail || 0) + (en.error || 0);
        let expireTxt = '—';
        let expireSoon = false;
        if (en.expiresAt) {
          const t = Date.parse(en.expiresAt);
          if (!Number.isNaN(t)) {
            expireSoon = t - Date.now() < 3 * 86400000;
            const days = Math.ceil((t - Date.now()) / 86400000);
            expireTxt = days <= 0 ? '已到期' : days + '天';
          }
        }
        const toggle = () => setOpenId(isOpen ? null : en.id);

        const nameSpan = E('span', { style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: en.id },
          (isOpen ? '▾ ' : '▸ ') + shortName(en.id));
        const meta = E('span', { style: { flex: '0 0 auto', opacity: 0.75, fontSize: 11 } },
          (en.calls || 0) + '次 · TTFT ' + (en.avgTtftMs != null ? (en.avgTtftMs / 1000).toFixed(1) + 's' : '—') +
          (en.expiresAt ? ' · ' + (expireSoon ? '⚠' : '') + expireTxt : ''));

        const kids = [
          nameSpan,
          Badge(LAYER_TEXT[en.layer] || en.layer, LAYER_COLOR[en.layer] || 'rgba(128,128,128,0.2)'),
          en.tier ? Badge('质' + en.tier, TIER_BG[en.tier] || 'rgba(128,128,128,0.2)') : null,
          en.role === 'executor' ? Badge('执行者', 'rgba(34,197,94,0.22)') : null,
          RateBar(en.ok || 0, nAll),
          meta,
        ].filter(Boolean);
        const line = E('div', { key: en.id, style: rowS, onClick: toggle }, kids);

        if (!isOpen) return line;

        let lastTxt = '—';
        if (en.lastStatus != null) lastTxt = en.lastStatus + ' @ ' + fmtT(en.lastAt);
        const detail = E('div', { key: en.id + ':d', style: { borderBottom: '1px solid rgba(128,128,128,0.14)' } },
          E('div', { style: detS },
            E('div', null, '全名：' + en.id),
            E('div', null,
              '调用 ' + (en.calls || 0) + ' ＝ 成功 ' + (en.ok || 0) + ' + 失败 ' + (en.fail || 0) +
              ((en.error || en.abort) ? ' + 错误' + (en.error || 0) + '/中止' + (en.abort || 0) : '') +
              ' · 本时桶 ' + (en.hourlyOk || 0) + '/' + (en.hourlyOk + en.hourlyFail)),
            E('div', null,
              'Token 入 ' + fmtK(en.tokInTotal) + ' / 出 ' + fmtK(en.tokOutTotal) +
              (en.tokReasonTotal ? '（含推理 ' + fmtK(en.tokReasonTotal) + '）' : '') +
              ' · 最近：' + lastTxt)),
          E(EditForm, { key: en.id + ':form', en, act: withBusyAct }));
        return [line, detail];

        function withBusyAct(a, i, v) {
          return new Promise((res) => { withBusy(() => act(a, i, v).then(res)); });
        }
      }

      function groupCard(p) {
        const list = byProv[p];
        const totCalls = list.reduce((s, x) => s + (x.calls || 0), 0);
        const tokIn = list.reduce((s, x) => s + (x.tokInTotal || 0), 0);
        const hd = E('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, margin: '2px 0 6px' } },
          E('span', { style: { fontWeight: 650, fontSize: 13 } }, p),
          E('span', { style: { fontSize: 11, opacity: 0.7 } }, list.length + ' 条目 · ' + totCalls + ' 次 · tok ' + fmtK(tokIn)));
        const lines = list.map(entryLine);
        return E('div', { key: p, style: CARD }, hd, E('div', null, lines));
      }

      function rankCard() {
        const items = rank.map((r, i) => {
          const medal = MEDALS[i] || '#' + (i + 1);
          const barW = Math.round(r.score * 100) + '%';
          const subTxt = Math.round(r.okRate * 100) + '% · ' + r.n + '次' + (r.ttftMs != null ? ' · ' + (r.ttftMs / 1000).toFixed(1) + 's' : '');
          const bar = E('span', { style: { flex: 1, height: 6, borderRadius: 3, background: 'rgba(128,128,128,0.18)', overflow: 'hidden' } },
            E('span', { style: { display: 'block', height: '100%', width: barW, background: 'linear-gradient(90deg,#22c55e,#84cc16)' } }));
          return E('div', { key: r.id, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', fontSize: 12 } },
            E('span', { style: { width: 24, textAlign: 'center' } }, medal),
            E('span', { style: { flex: '0 0 auto', minWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, shortName(r.id)),
            bar,
            E('span', { style: { width: 34, textAlign: 'right', fontWeight: 600 } }, String(r.score)),
            E('span', { style: { width: 150, fontSize: 11, opacity: 0.75 } }, subTxt));
        });
        return E('div', { style: CARD },
          E('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 8 } }, '🏆 可用性排行（后验均值 × 延迟惩罚）'),
          E('div', null, items));
      }

      function feedCard(title, icon, rows, emptyTxt) {
        if (!rows.length) {
          return E('div', { style: CARD },
            E('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 6 } }, icon + ' ' + title),
            E('div', { style: { fontSize: 12, opacity: 0.6 } }, emptyTxt));
        }
        return E('div', { style: CARD },
          E('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 6 } }, icon + ' ' + title),
          E('div', { style: { fontSize: 12, lineHeight: 1.8 } }, rows));
      }

      const switchItems = switches.slice().reverse().map((sw, i) => {
        const routeLine = E('span', null,
          E('strong', null, sw.from), ' → ', E('strong', null, sw.to),
          E('span', { style: { opacity: 0.65 } }, '  [' + sw.why + ']'));
        return E('div', { key: i, style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
          E('span', { style: { opacity: 0.55, fontSize: 11, flex: '0 0 60px' } }, fmtT(sw.at)),
          routeLine);
      });

      const pickItems = picks.slice().reverse().map((pk, i) => E('div', { key: i },
        E('span', { style: { opacity: 0.55, marginRight: 8 } }, pk.why),
        pk.id + '  ',
        E('strong', null, 'v=' + pk.v)));

      const headBar = E('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
        E('span', { style: { fontWeight: 700, fontSize: 14 } }, '穷鬼路由器'),
        E('button', { style: Object.assign({}, btn, { color: sum.routingEnabled ? '#22c55e' : '#9ca3af' }), disabled: busy, onClick: () => withBusy(() => act('setRouting', 'global', { enabled: !sum.routingEnabled })) },
          '● 路由 ' + (sum.routingEnabled ? 'ON' : 'OFF')),
        E('button', { style: Object.assign({}, btn, { color: sum.adaptiveEnabled ? '#22c55e' : '#9ca3af' }), disabled: busy, onClick: () => withBusy(() => act('setAdaptive', 'global', { enabled: !sum.adaptiveEnabled })) },
          '● 自适应 ' + (sum.adaptiveEnabled ? 'ON' : 'OFF')),
        E('button', { style: Object.assign({}, btn, { color: sum.badgeEnabled !== false ? '#22c55e' : '#9ca3af' }), disabled: busy, title: '输入框左侧的⚡改道指示灯显示开关', onClick: () => withBusy(() => act('setBadge', 'global', { enabled: sum.badgeEnabled === false })) },
          '● 指示灯 ' + (sum.badgeEnabled !== false ? 'ON' : 'OFF')),
        E('button', { style: btn, disabled: busy, onClick: () => withBusy(() => load()) }, busy ? '…' : '刷新'),
        E('button', { style: btn, disabled: busy, title: 'pool.json 有手动改动后点此重载', onClick: () => withBusy(() => act('reloadPool', 'global').then(() => load())) }, '重载'));

      let paidChip = null;
      if (sum.paidSpend && sum.paidSpend.length) {
        let tot = 0; let danger = false;
        for (const p of sum.paidSpend) {
          tot += p.spendYuan || 0;
          if (p.capYuan && (p.spendYuan || 0) >= p.capYuan * 0.9) danger = true;
        }
        paidChip = E('span', { style: Object.assign({}, chipS, { color: danger ? '#ef4444' : '#f59e0b' }), title: '付费模型今日消费（逃生舱启用时才会增长）' },
          '真钱 ¥' + tot.toFixed(3));
      }
      const statBar = E('div', { style: { marginBottom: 10 } }, [
        E('span', { style: chipS }, '改道 ' + (sum.routedAway || 0)),
        E('span', { style: chipS }, '请求级 ' + (sum.routedIn || 0)),
        E('span', { style: chipS }, '计量 ' + (sum.metricsCaptured || 0)),
        E('span', { style: chipS }, '自动登记 ' + (sum.autoRegistered || 0)),
        paidChip,
        E('span', { style: chipS }, '冷却 ' + ((sum.providerCooldowns || []).length)),
        E('span', { style: chipS }, '条目 ' + (sum.loaded || 0)),
      ].filter(Boolean));

      const kids = [headBar, statBar];
      if (err) kids.push(E('div', { style: { color: '#ef4444', fontSize: 12, marginBottom: 8 } }, err));
      if (rank.length) kids.push(rankCard());
      for (const p of provs) kids.push(groupCard(p));
      kids.push(feedCard('最近改道', '🔀', switchItems, '暂无'));
      if (picks.length) kids.push(feedCard('TS 采样记录', '🎲', pickItems, '暂无'));
      kids.push(E('div', { style: { fontSize: 11, opacity: 0.55, marginTop: -4 } },
        '提示：点击模型行展开详情与编辑；质量档点选即时生效（决定改道时的同质量圈）；往 pool.json 手动加新模型后点「重载」即可生效。'));

      return E('div', { style: { padding: '6px 2px 20px' } }, kids);
    }

    function RouteBadge() {
      const st = React.useState(null);
      const info = st[0]; const setInfo = st[1];
      const enSt = React.useState(true);
      const badgeOn = enSt[0]; const setBadgeOn = enSt[1];
      React.useEffect(() => {
        let alive = true;
        let since = null;
        const loop = function () {
          if (!alive) return;
          api('routeState', { since })
            .then(function (r) {
              if (!alive) return;
              if (r && typeof r.badge === 'boolean') setBadgeOn(r.badge);
              setInfo(r);
              const ls = r && r.lastSwitch;
              if (ls && ls.at) since = ls.at;
              loop();
            })
            .catch(function () { /* 断线即停，connection/reset 时重启 */ });
        };
        loop();
        const offReset = ctx.on('connection/reset', function () { loop(); });
        return function () { alive = false; offReset(); };
      }, []);
      const onClick = function () {
        api('routeState', { since: null })
          .then((r) => setInfo(r)).catch(() => {});
      };
      if (!badgeOn || !info || !info.lastSwitch) return null;
      const sw = info.lastSwitch;
      let fresh = true;
      try { fresh = (Date.now() - Date.parse(sw.at)) < 10 * 60000; } catch (e) { fresh = true; }
      return E('span', {
        title: '最近一笔请求实际由 ' + sw.to + ' 服务 [' + sw.why + '] @ ' + fmtT(sw.at) + '（点击刷新）',
        onClick: onClick,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontSize: 11, padding: '2px 9px', borderRadius: 999,
          cursor: 'pointer', flex: '0 0 auto',
          background: fresh ? 'rgba(245,158,11,0.18)' : 'rgba(128,128,128,0.12)',
          color: fresh ? '#d97706' : 'inherit',
          opacity: fresh ? 1 : 0.5,
          border: '1px solid ' + (fresh ? 'rgba(217,119,6,0.35)' : 'transparent'),
        },
      }, '⚡ 已改道 → ' + shortName(sw.to));
    }

    slots.inject('conversation.input.left', () => slots.register(
      { name: 'conversation.input.left', id: 'poor-router-flag', order: 40, label: '改道指示' },
      () => E(RouteBadge),
    ));

    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'poor-router', order: 90, label: '穷鬼路由器' },
      () => E(Dashboard),
    ));
      },
    }
  },
})
