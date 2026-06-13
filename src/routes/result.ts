// ---- Agent result callback (/jobs/:id/result) ----------------------------
// Called by the Conductor agent when surface_scan / research / tailor / refine completes.

import type { Env, JobRow } from '../types';
import { JSON_H } from '../types';
import { getJob, updateJob, upsertCompany } from '../db';
import { cardBlocks } from '../blocks';
import { safeUpdateCard, postMsg, uploadToThread, publishHome, wakeAgent, moveThread } from '../slack';

export async function handleJobResult(env: Env, id: string, body: Record<string, unknown>): Promise<Response> {
  const job = await getJob(env, id);
  if (!job) return new Response(JSON.stringify({ error: 'job not found' }), { status: 404, headers: JSON_H });
  if (!job.channel_id || !job.card_ts) return new Response(JSON.stringify({ error: 'no slack coordinates' }), { status: 422, headers: JSON_H });

  const rootTs = job.root_ts ?? '';

  // After any result, refresh the owner's App Home
  const homeRefresh = () => job.owner_id ? publishHome(env, job.owner_id) : Promise.resolve();

  // ---- surface_scan -------------------------------------------------------
  if (body.type === 'surface_scan') {
    const scores: Record<string, string> = {};
    if (body.comp) scores.comp = body.comp as string;
    const wm = [body.work_model, body.location].filter(Boolean).join(' · ');
    if (wm) scores.work_model = wm;
    if (body.commute) scores.commute = body.commute as string;
    if (body.stack) scores.stack = body.stack as string;
    if (body.notes) scores.notes = body.notes as string;

    // Upsert company record and link this job to it so sibling jobs at the same
    // company can share research without repeating it.
    let companyId: string | null = job.company_id ?? null;
    if (body.company) {
      companyId = await upsertCompany(env, body.company as string, (body.domain as string | undefined) ?? null);
    }

    await updateJob(env, id, {
      company_id: companyId,
      company: (body.company as string) || job.company,
      role: (body.role as string) || job.role,
      location: (body.location as string) || job.location,
      work_model: (body.work_model as string) || job.work_model,
      comp_text: (body.comp as string) || job.comp_text,
      scores_json: JSON.stringify(scores),
      status: 'scored',
    });
    const updated = await getJob(env, id);
    await safeUpdateCard(env, updated!, `${updated!.company ?? ''} — ${updated!.role ?? ''}`, cardBlocks(updated!));
    await homeRefresh();
  }

  // ---- research -----------------------------------------------------------
  if (body.type === 'research') {
    const queuedTailor = job.queued_next === 'tailor_after_research';
    await updateJob(env, id, {
      status: queuedTailor ? 'tailoring' : 'researched',
      brief_key: (body.brief_key as string) || job.brief_key,
      tailor_state: queuedTailor ? 'in_progress' : job.tailor_state,
      queued_next: 'none',
    });
    const updated = await getJob(env, id);
    await safeUpdateCard(env, updated!, 'Research complete', cardBlocks(updated!));

    if (body.brief_key && rootTs) {
      await uploadToThread(env, body.brief_key as string, job.channel_id, rootTs, 'Research Brief', (body.summary as string) || 'Research complete.');
    } else if (body.summary && rootTs) {
      await postMsg(env, job.channel_id, body.summary as string, undefined, rootTs);
    }

    if (queuedTailor) await wakeAgent(env, 'tailor', id);
    await homeRefresh();
  }

  // ---- tailor / refine ----------------------------------------------------
  if (body.type === 'tailor' || body.type === 'refine') {
    const queuedStage = job.queued_next === 'stage_after_tailor';
    await updateJob(env, id, {
      status: 'tailored',
      tailor_state: 'done',
      resume_pdf_key: (body.resume_pdf_key as string) || job.resume_pdf_key,
      queued_next: 'none',
    });
    const updated = await getJob(env, id);
    await safeUpdateCard(env, updated!, 'Tailoring complete', cardBlocks(updated!));

    if (body.resume_pdf_key && rootTs) {
      await uploadToThread(env, body.resume_pdf_key as string, job.channel_id, rootTs, 'Tailored Resume', (body.decisions as string) || 'Tailoring complete.');
    }

    if (queuedStage && env.STAGE_CHANNEL) {
      const stageJob = await getJob(env, id);
      if (stageJob) {
        await updateJob(env, id, { status: 'staging' });
        const stagingJob = await getJob(env, id);
        await safeUpdateCard(env, stagingJob!, 'Staging…', cardBlocks(stagingJob!));
        await moveThread(env, stageJob, env.STAGE_CHANNEL);
      }
    }
    await homeRefresh();
  }

  return new Response(JSON.stringify({ ok: true }), { headers: JSON_H });
}
