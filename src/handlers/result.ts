import type { Env, JobRow } from '#/types';
import { createResponseInit } from '#/headers';
import { getJob, updateJob, upsertCompany } from '#/db';
import { createCard } from '#/build/createCard';
import { updateMsg, postMsg, uploadToThread, publishHome, wakeAgent, moveThread } from '#/slack';

export async function handleJobResult(env: Env, id: string, body: Record<string, unknown>): Promise<Response> {
  const job = await getJob(env, id);
  if (!job) {
    return new Response(JSON.stringify({ error: 'job not found' }), createResponseInit('json', 404));
  }
  if (!job.channel_id || !job.card_ts) {
    return new Response(JSON.stringify({ error: 'no slack coordinates' }), createResponseInit('json', 422));
  }

  const channelId = job.channel_id;
  const cardTs = job.card_ts;
  const rootTs = job.root_ts ?? '';

  const refreshHome = () => job.owner_id ? publishHome(env, job.owner_id) : Promise.resolve();

  if (body.type === 'surface_scan') {
    const scores: Record<string, string> = {};
    if (body.comp) {
      scores.comp = body.comp as string;
    }
    const workModelText = [body.work_model, body.location].filter(Boolean).join(' · ');
    if (workModelText) {
      scores.work_model = workModelText;
    }
    if (body.commute) {
      scores.commute = body.commute as string;
    }
    if (body.stack) {
      scores.stack = body.stack as string;
    }
    if (body.notes) {
      scores.notes = body.notes as string;
    }

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
    await updateMsg(env, channelId, cardTs, `${updated!.company ?? ''} — ${updated!.role ?? ''}`, createCard(updated!));
    await refreshHome();
  }

  if (body.type === 'research') {
    const queuedTailor = job.queued_next === 'tailor_after_research';
    await updateJob(env, id, {
      status: queuedTailor ? 'tailoring' : 'researched',
      brief_key: (body.brief_key as string) || job.brief_key,
      tailor_state: queuedTailor ? 'in_progress' : job.tailor_state,
      queued_next: 'none',
    });
    const updated = await getJob(env, id);
    await updateMsg(env, channelId, cardTs, 'Research complete', createCard(updated!));

    if (body.brief_key && rootTs) {
      await uploadToThread(env, body.brief_key as string, channelId, rootTs, 'Research Brief', (body.summary as string) || 'Research complete.');
    } else if (body.summary && rootTs) {
      await postMsg(env, channelId, body.summary as string, undefined, rootTs);
    }

    if (queuedTailor) {
      await wakeAgent(env, 'tailor', id);
    }
    await refreshHome();
  }

  if (body.type === 'tailor' || body.type === 'refine') {
    const queuedStage = job.queued_next === 'stage_after_tailor';
    await updateJob(env, id, {
      status: 'tailored',
      tailor_state: 'done',
      resume_pdf_key: (body.resume_pdf_key as string) || job.resume_pdf_key,
      queued_next: 'none',
    });
    const updated = await getJob(env, id);
    await updateMsg(env, channelId, cardTs, 'Tailoring complete', createCard(updated!));

    if (body.resume_pdf_key && rootTs) {
      await uploadToThread(env, body.resume_pdf_key as string, channelId, rootTs, 'Tailored Resume', (body.decisions as string) || 'Tailoring complete.');
    }

    if (queuedStage && env.STAGE_CHANNEL) {
      const stageJob = await getJob(env, id);
      if (stageJob) {
        await updateJob(env, id, { status: 'staging' });
        await updateMsg(env, channelId, cardTs, 'Staging…', createCard({ ...stageJob, status: 'staging' } as JobRow));
        await moveThread(env, stageJob, env.STAGE_CHANNEL);
      }
    }
    await refreshHome();
  }

  return new Response(JSON.stringify({ ok: true }), createResponseInit('json'));
}
