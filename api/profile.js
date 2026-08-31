/**
 * Mockingbird — the voice profile, in the open.
 *
 * The profile is what makes Mockingbird feel like it knows the person using
 * it: how they write, the names they use, how they work a deal. It is built
 * from their own dictations (see api/_lib/profile.js) — and it is theirs to
 * read and delete, which is the whole reason this endpoint exists.
 *
 * GET    /api/profile?user=erik           → { summary, profile, updated_at }
 * POST   /api/profile { user, refresh }   → rebuild now from recent activity
 * DELETE /api/profile?user=erik           → erase it
 */
import { preflight } from './_lib/http.js';
import { getProfile, distill, forgetProfile, learningEnabled } from './_lib/profile.js';

export default async function handler(req, res) {
  if (preflight(req, res, 'GET, POST, DELETE, OPTIONS')) return;

  const user = (req.query && req.query.user) || (req.body && req.body.user) || '';
  if (!user) return res.status(400).json({ error: 'Missing "user"' });

  if (!learningEnabled()) {
    return res.status(200).json({ enabled: false, profile: null, summary: '' });
  }

  try {
    if (req.method === 'DELETE') {
      await forgetProfile(user);
      return res.status(200).json({ enabled: true, deleted: true, profile: null, summary: '' });
    }

    if (req.method === 'POST') {
      const row = await distill(user, { force: true });
      return res.status(200).json({
        enabled: true,
        summary: (row && row.summary) || '',
        profile: (row && row.profile) || null,
        updated_at: row && row.updated_at
      });
    }

    const row = await getProfile(user);
    return res.status(200).json({
      enabled: true,
      summary: (row && row.summary) || '',
      profile: (row && row.profile) || null,
      updated_at: row && row.updated_at,
      events_seen: row && row.events_seen
    });
  } catch (err) {
    console.error('mockingbird profile error:', err);
    return res.status(502).json({ error: 'Profile unavailable' });
  }
}
