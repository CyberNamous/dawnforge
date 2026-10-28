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
