// Token Radar's plain dashboard. It reads window.RADAR (written beside dashboard/ by main.ts)
// and renders the ranked board, a filterable table, and a per-protocol detail drawer carrying the
// model's own inputs and the protocol's farm plan. No network: every byte it shows is in data.js.
(function () {
  'use strict';

  const RADAR = window.RADAR;
  if (!RADAR) return;
  const root = document.getElementById('board');
  const view = { q: '', category: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  const usdFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function formatUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFormatter.format(n);
  }
  function formatPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function formatAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  // The model in one function: the page recomputes a row from the snapshot figures and checks the
  // number board.json carries, so the page's code and the board's data are visibly the same arithmetic.
  // The base multiple is the category's median live market-cap/TVL (clamped 0.05-1.50, 0.25 when the
  // category has fewer than 3 live protocols), and multi-chain protocols earn up to +8%.
  function recomputeImplied(row, model) {
    const multiple = (model.category_multiples && model.category_multiples[row.category || 'Other']) || model.base_multiple;
    const clamped = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    const growthFactor = 1 + (clamped / 100) * model.growth_weight;
    const ageUsed = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    const maturityFactor = model.maturity_floor + (Math.min(Math.max(ageUsed, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    const chainCount = row.chains && row.chains.length ? row.chains.length : 1;
    const chainFactor = 1 + model.chain_step * Math.min(Math.max(chainCount - 1, 0), model.chain_max_steps);
    return Math.max(1, Math.round(row.tvl_usd * multiple * growthFactor * maturityFactor * chainFactor));
  }

  function h(tag, attrs) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and age
  // decide the action, the capital, the hold and every cost and time. No name is special-cased.
  function firstChain(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function stakeSize(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdWindow(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function planAction(p, capital, chain) {
    const c = (p.category || '').toLowerCase();
    const name = p.name;
    if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.includes('bridge')) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.includes('staking') || c.includes('restak')) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.includes('perpetual') || c.includes('derivative')) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.includes('prediction')) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.includes('curator') || c.includes('allocator')) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.includes('stable')) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.includes('rwa')) return "Mint $" + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.includes('insurance')) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function renderStep(step) {
    let s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function planSteps(p) {
    const chain = firstChain(p);
    const capital = stakeSize(p);
    const hold = holdWindow(p.age_days);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: planAction(p, capital, chain), cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(renderStep);
  }

  function readStateFromHash() {
    const fragment = window.location.hash.replace(/^#/, '');
    if (!fragment) return;
    const query = new URLSearchParams(fragment);
    if (query.get('q')) view.q = query.get('q');
    if (query.get('p')) view.selected = query.get('p');
    if (query.get('category')) view.category = query.get('category');
  }
  function writeStateToHash() {
    const query = new URLSearchParams();
    if (view.q) query.set('q', view.q);
    if (view.category !== 'all') query.set('category', view.category);
    if (view.selected) query.set('p', view.selected);
    const encoded = query.toString();
    if (encoded) window.history.replaceState(null, '', '#' + encoded);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function visibleRows() {
    const q = view.q.trim().toLowerCase();
    return RADAR.rows.filter(function (r) {
      if (view.category !== 'all' && r.category !== view.category) return false;
      if (!q) return true;
      const hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  function sortRows(list) {
    const key = view.sort;
    return list.slice().sort(function (a, b) {
      let aVal, bVal;
      if (key === 'name') { aVal = a.name.toLowerCase(); bVal = b.name.toLowerCase(); }
      else if (key === 'tvl') { aVal = a.tvl_usd; bVal = b.tvl_usd; }
      else if (key === 'growth') { aVal = a.change_7d === null ? -Infinity : a.change_7d; bVal = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { aVal = a.age_days === null ? Infinity : a.age_days; bVal = b.age_days === null ? Infinity : b.age_days; }
      else { aVal = a.implied_value_usd; bVal = b.implied_value_usd; }
      if (aVal < bVal) return -view.dir;
      if (aVal > bVal) return view.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function topBar() {
    return h('header', { class: 'top' },
      h('div', { class: 'brand' },
        h('span', { class: 'mark', text: 'R' }),
        h('div', { class: 'brand-name' }, 'Token Radar', h('small', { text: 'Pre-token protocol index' }))
      ),
      h('div', { class: 'top-meta' },
        h('span', null, 'Snapshot ', h('b', { text: RADAR.as_of })),
        h('span', { text: 'DefiLlama protocol index' }),
        h('span', null, 'Model ', h('b', { text: RADAR.model_version }))
      )
    );
  }

  function intro() {
    return h('section', { class: 'lede' },
      h('div', null,
        h('h1', { text: RADAR.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        h('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(RADAR.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + RADAR.early_size + ' pre-token protocols below that floor. Implied value is a model, not a promise.' })
      ),
      h('div', { class: 'facts' },
        h('div', { class: 'fact' }, h('span', { text: 'Watchlist covered' }), h('b', { text: RADAR.watchlist_size + ' / ' + RADAR.watchlist_size })),
        h('div', { class: 'fact' }, h('span', { text: 'Pre-token rows scored' }), h('b', { text: String(RADAR.board_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Early rows below the floor' }), h('b', { text: String(RADAR.early_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Live-token protocols set aside' }), h('b', { text: String(RADAR.live_size) }))
      )
    );
  }

  function filterBar() {
    const categoryList = Array.from(new Set(RADAR.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    const searchBox = h('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.q, 'aria-label': 'Search the board' });
    searchBox.addEventListener('input', function () { view.q = searchBox.value; writeStateToHash(); draw(); });
    const categorySelect = h('select', { id: 'category', 'aria-label': 'Filter by category' },
      h('option', { value: 'all', text: 'All categories' }),
      categoryList.map(function (c) { return h('option', { value: c, text: c, selected: c === view.category ? 'selected' : null }); })
    );
    categorySelect.addEventListener('change', function () { view.category = categorySelect.value; writeStateToHash(); draw(); });
    const preBtn = h('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { view.tab = 'pre-token'; draw(); } });
    const liveBtn = h('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { view.tab = 'live'; draw(); } });
    return h('div', { class: 'controls' },
      h('div', { class: 'field' }, h('label', { for: 'q', text: 'Search' }), searchBox),
      h('div', { class: 'field' }, h('label', { for: 'category', text: 'Category' }), categorySelect),
      h('div', { class: 'field' }, h('span', { class: 'sub', text: 'Token status' }), h('div', { class: 'tabs' }, preBtn, liveBtn)),
      h('span', { class: 'count', text: view.tab === 'pre-token' ? visibleRows().length + ' rows shown' : RADAR.live.length + ' live-token protocols' })
    );
  }

  function sortableHeader(key, label) {
    return h('th', { scope: 'col' },
      h('button', { type: 'button', onclick: function () { if (view.sort === key) view.dir = -view.dir; else { view.sort = key; view.dir = -1; } draw(); } },
        label,
        view.sort === key ? h('span', { 'aria-hidden': 'true', text: view.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function preTokenTable() {
    const visible = sortRows(visibleRows());
    if (visible.length === 0) {
      return h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('h2', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category to see the board again.' }),
        h('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { view.q = ''; view.category = 'all'; writeStateToHash(); draw(); } })
      ));
    }
    const topValue = visible[0].implied_value_usd || 1;
    const body = h('tbody');
    visible.forEach(function (r) {
      const growthText = r.change_7d === null ? 'n/a' : formatPct(r.change_7d);
      const growthTone = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      const rankTone = r.rank === 1 ? 'rank top1' : r.rank <= 3 ? 'rank top3' : r.rank <= 10 ? 'rank top10' : 'rank';
      const rowEl = h('tr', {
        'data-selected': view.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { showDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showDetail(r.slug); } }
      },
        h('td', null, h('span', { class: rankTone, text: String(r.rank) })),
        h('td', null, h('div', { class: 'name' },
          h('b', { text: r.name }),
          h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        h('td', { class: 'num', text: formatUsd(r.tvl_usd) }),
        h('td', { class: 'num ' + growthTone, text: growthText }),
        h('td', { class: 'num', text: formatAge(r.age_days) }),
        h('td', null, h('div', { class: 'implied' },
          h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / topValue) * 100)) + '%' })),
          h('span', { class: 'num', text: formatUsd(r.implied_value_usd) })
        )),
        h('td', null, h('span', { class: 'status', text: 'no token' }))
      );
      body.appendChild(rowEl);
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          h('thead', null, h('tr', null,
            sortableHeader('implied', 'Rank'),
            sortableHeader('name', 'Protocol'),
            sortableHeader('tvl', 'TVL'),
            sortableHeader('growth', '7d'),
            sortableHeader('age', 'Age'),
            sortableHeader('implied', 'Implied value'),
            h('th', { scope: 'col', text: 'Token' })
          )),
          body
        )
      )
    );
  }

  function liveTokenTable() {
    const body = h('tbody');
    RADAR.live.forEach(function (r) {
      body.appendChild(h('tr', null,
        h('td', { class: 'num', text: 'live' }),
        h('td', null, h('div', { class: 'name' }, h('b', { text: r.name }), h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        h('td', { class: 'num', text: formatUsd(r.tvl_usd) }),
        h('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: formatPct(r.change_7d) }),
        h('td', { class: 'num', text: formatUsd(r.mcap_usd) }),
        h('td', null, h('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Status' }), h('th', { scope: 'col', text: 'Protocol' }), h('th', { scope: 'col', text: 'TVL' }), h('th', { scope: 'col', text: '7d' }), h('th', { scope: 'col', text: 'Market cap' }), h('th', { scope: 'col', text: 'Token' }))),
          body
        )
      )
    );
  }

  function modelSection() {
    const model = RADAR.model;
    const multipleList = Object.keys(model.category_multiples || {}).sort().map(function (c) { return c + ' ' + model.category_multiples[c]; }).join(', ');
    return h('section', { class: 'panel model' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      h('div', { class: 'formula' },
        'implied = round( tvl_usd x category_multiple x (1 + clamp(change_7d, ' + model.growth_floor + ', ' + model.growth_cap + ') / 100 x ' + model.growth_weight + ') x (' + model.maturity_floor + ' + min(age_days, ' + model.maturity_days + ') / ' + model.maturity_days + ' x ' + model.maturity_range + ') x (1 + ' + model.chain_step + ' x min(chains - 1, ' + model.chain_max_steps + ')) )'
      ),
      h('p', { class: 'sub', text: 'category_multiple is the median market-cap/TVL of the live-token protocols in that category, clamped to 0.05-1.50; a category with fewer than 3 live protocols uses the ' + model.base_multiple + ' fallback. This snapshot: ' + multipleList + '.' }),
      h('p', { class: 'sub', text: 'TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + model.unknown_age_days + ' days. The chain factor adds ' + (model.chain_step * 100) + '% per extra chain, up to +' + (model.chain_step * model.chain_max_steps * 100) + '%. The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.' })
    );
  }

  const drawer = h('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  drawer.addEventListener('close', function () { view.selected = null; writeStateToHash(); });

  function showDetail(slug) {
    const picked = RADAR.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!picked) return;
    view.selected = slug;
    writeStateToHash();
    drawer.textContent = '';
    const plan = planSteps(picked);
    drawer.appendChild(h('div', { class: 'detail-head' },
      h('div', null,
        h('span', { class: 'brand-name', text: 'Rank ' + picked.rank + ' of ' + RADAR.board_size }),
        h('h2', { id: 'detail-title', text: picked.name }),
        h('p', { class: 'sub', text: (picked.category || 'Other') + ' on ' + (picked.chains && picked.chains.length ? picked.chains.join(', ') : 'an unnamed chain') })
      ),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { drawer.close(); } })
    ));
    drawer.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'equation' },
        h('div', null, h('span', { text: 'TVL' }), h('b', { class: 'num', text: formatUsd(picked.tvl_usd) })),
        h('div', null, h('span', { text: 'Category multiple (' + (picked.category || 'Other') + ')' }), h('b', { class: 'num', text: String(picked.base_multiple) })),
        h('div', null, h('span', { text: 'Seven-day growth' }), h('b', { class: 'num', text: formatPct(picked.change_7d) })),
        h('div', null, h('span', { text: 'Age with no token' }), h('b', { class: 'num', text: formatAge(picked.age_days) })),
        h('div', null, h('span', { text: 'Growth multiplier' }), h('b', { class: 'num', text: String(picked.growth_multiplier) })),
        h('div', null, h('span', { text: 'Maturity multiplier' }), h('b', { class: 'num', text: String(picked.maturity_multiplier) })),
        h('div', null, h('span', { text: 'Chain multiplier (' + (picked.chains ? picked.chains.length : 1) + ' chain' + ((picked.chains ? picked.chains.length : 1) === 1 ? '' : 's') + ')' }), h('b', { class: 'num', text: String(picked.chain_multiplier) })),
        h('div', null, h('span', { text: 'Implied value' }), h('b', { class: 'num', text: formatUsd(picked.implied_value_usd) }))
      ),
      h('p', { class: 'sub', text: 'Model ' + RADAR.model_version + ': the same function scores every protocol. The page recomputes this row as ' + formatUsd(recomputeImplied(picked, RADAR.model)) + (recomputeImplied(picked, RADAR.model) === picked.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    drawer.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Farm plan' }),
      h('ol', { class: 'steps' }, plan.map(function (s) {
        const at = s.indexOf(' Cost: ');
        const action = at >= 0 ? s.slice(0, at) : s;
        const tail = at >= 0 ? s.slice(at + 1) : '';
        return h('li', null, h('b', { text: action }), h('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof drawer.showModal === 'function') {
      if (!drawer.open) drawer.showModal();
    } else {
      drawer.setAttribute('open', '');
    }
  }

  function draw() {
    root.textContent = '';
    const page = h('div', { class: 'shell' });
    page.appendChild(topBar());
    page.appendChild(intro());
    page.appendChild(filterBar());
    page.appendChild(view.tab === 'pre-token' ? preTokenTable() : liveTokenTable());
    if (view.tab === 'pre-token') page.appendChild(modelSection());
    root.appendChild(page);
    root.setAttribute('aria-busy', 'false');
    if (!drawer.isConnected) root.appendChild(drawer);
    if (view.selected) showDetail(view.selected);
  }

  readStateFromHash();
  draw();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drawer.open) drawer.close();
  });
})();
