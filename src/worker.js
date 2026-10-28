const ROLES = ['Jungle', 'Roam', 'Mid', 'Gold', 'EXP'];
const ALL = [...ROLES, 'None'];
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const bump = (env) => env.DB.prepare('UPDATE tournaments SET current_version = current_version + 1 WHERE id = 1');

async function place(env, id, team, role) {
  const p = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(id).first();
  if (!p) return false;
  if (!team) {
    await env.DB.batch([env.DB.prepare('UPDATE players SET assigned_team=NULL, assigned_role=NULL WHERE id=?').bind(id), bump(env)]);
    return true;
  }
  const rows = (await env.DB.prepare('SELECT id, assigned_role AS r FROM players WHERE assigned_team = ?').bind(team).all()).results.filter(x => x.id !== id);
  const taken = rows.map(x => x.r);
  if (!ROLES.includes(role)) role = [p.main_role, p.side_role, ...ROLES].find(r => ROLES.includes(r) && !taken.includes(r));
  if (!role) return false; // team full
  const occ = rows.find(x => x.r === role);
  const up = 'UPDATE players SET assigned_team=?, assigned_role=? WHERE id=?';
  const st = [];
  if (occ) st.push(env.DB.prepare(up).bind(p.assigned_team, p.assigned_role, occ.id)); // swap occupant into mover's old slot
  st.push(env.DB.prepare(up).bind(team, role, id), bump(env));
  await env.DB.batch(st);
  return true;
}

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Random, role-aware distribution into 2 teams x 5 roles.
// keep=true  -> only fill open slots with benched players
// keep=false -> clear everything and reshuffle all players
async function randomize(env, keep) {
  const all = (await env.DB.prepare('SELECT id, main_role, side_role, is_flex, assigned_team, assigned_role FROM players').all()).results;
  const TEAMS = ['Team A', 'Team B'];
  const open = { 'Team A': new Set(ROLES), 'Team B': new Set(ROLES) };
  const count = { 'Team A': 0, 'Team B': 0 };
  let pool = all;
  if (keep) {
    all.filter(p => p.assigned_team).forEach(p => { open[p.assigned_team].delete(p.assigned_role); count[p.assigned_team]++; });
    pool = all.filter(p => !p.assigned_team);
  }
  shuffle(pool);
  const cap = Math.ceil(Math.min(10, all.length) / 2); // keeps team sizes even when fewer than 10 players
  const result = new Map();
  // put player in `role` on the emptier team that still has that role open
  const put = (p, role) => {
    const teams = TEAMS.filter(t => open[t].has(role) && count[t] < cap);
    if (!teams.length) return false;
    const min = Math.min(...teams.map(t => count[t]));
    const t = shuffle(teams.filter(x => count[x] === min))[0];
    open[t].delete(role); count[t]++; result.set(p.id, [t, role]);
    return true;
  };
  const left = () => pool.filter(p => !result.has(p.id));
  const any = (p) => { for (const r of shuffle([...ROLES])) if (put(p, r)) break; };
  left().forEach(p => ROLES.includes(p.main_role) && put(p, p.main_role)); // 1) main role
  left().forEach(p => ROLES.includes(p.side_role) && put(p, p.side_role)); // 2) side role
  left().filter(p => p.is_flex).forEach(any);                              // 3) flex players, any role
  left().forEach(any);                                                     // 4) fill remaining slots; rest stay subs
  const st = [];
  if (!keep) st.push(env.DB.prepare('UPDATE players SET assigned_team=NULL, assigned_role=NULL'));
  for (const [id, [t, r]] of result) st.push(env.DB.prepare('UPDATE players SET assigned_team=?, assigned_role=? WHERE id=?').bind(t, r, id));
  st.push(bump(env));
  await env.DB.batch(st);
  return result.size;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      // 5s poll: reads ONLY the tournaments row, never the players table
      if (path === '/api/poll') {
        const r = await env.DB.prepare('SELECT current_version v FROM tournaments WHERE id = 1').first();
        return json(Number(url.searchParams.get('v')) === r.v ? { changed: false } : { changed: true, version: r.v });
      }
      if (path === '/api/bundle') {
        const [t, p] = await env.DB.batch([
          env.DB.prepare('SELECT current_version v, status FROM tournaments WHERE id = 1'),
          env.DB.prepare('SELECT id, ign, main_role, side_role, is_flex, assigned_team, assigned_role FROM players ORDER BY id')
        ]);
        return json({ version: t.results[0].v, status: t.results[0].status, players: p.results });
      }
      if (path === '/api/register' && req.method === 'POST') {
        const b = await req.json();
        const ign = String(b.ign || '').trim().slice(0, 24);
        if (!ign || !ALL.includes(b.main_role) || !ALL.includes(b.side_role)) return json({ error: 'Invalid input' }, 400);
        try {
          await env.DB.batch([
            env.DB.prepare('INSERT INTO players (ign, main_role, side_role, is_flex) VALUES (?,?,?,?)').bind(ign, b.main_role, b.side_role, b.is_flex ? 1 : 0),
            bump(env)
          ]);
        } catch (e) { return json({ error: 'IGN already registered' }, 409); }
        return json({ ok: true });
      }
      if (path.startsWith('/api/admin/')) {
        if (req.headers.get('x-owner-token') !== env.OWNER_SECRET_TOKEN) return json({ error: 'Unauthorized' }, 401);
        if (path === '/api/admin/login') return json({ ok: true });
        const b = await req.json().catch(() => ({}));
        if (path === '/api/admin/delete') {
          await env.DB.batch([env.DB.prepare('DELETE FROM players WHERE id = ?').bind(b.id), bump(env)]);
          return json({ ok: true });
        }
        if (path === '/api/admin/reset') {
          await env.DB.batch([env.DB.prepare('UPDATE players SET assigned_team=NULL, assigned_role=NULL'), bump(env)]);
          return json({ ok: true });
        }
        if (path === '/api/admin/randomize') { // { keep: true } fills open slots only; otherwise full reshuffle
          const placed = await randomize(env, !!b.keep);
          return json({ ok: true, placed });
        }
        if (path === '/api/admin/place') { // team: 'Team A' | 'Team B' | null (bench); role optional
          if (b.team && !['Team A', 'Team B'].includes(b.team)) return json({ error: 'Bad team' }, 400);
          const ok = await place(env, b.id, b.team || null, b.role);
          return ok ? json({ ok: true }) : json({ error: 'Team full or player not found' }, 409);
        }
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) { return json({ error: 'Server error' }, 500); }
  }
};
