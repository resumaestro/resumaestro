import type { Env } from '#/types';
import { createResponseInit } from '#/headers';
import { getJob, updateJob, upsertCompany } from '#/db';
import { createCard } from '#/build/createCard';
import { updateMsg, postMsg, uploadToThread, publishHome } from '#/slack';

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
    let companyId: string | null = job.company_id ?? null;
    if (body.company) {
      companyId = await upsertCompany(env, body.company as string, (body.domain as string | undefined) ?? null);
    }

    await updateJob(env, id, {
      in_flight: null,
      company_id: companyId,
      company: (body.company as string) || job.company,
      role: (body.role as string) || job.role,
      location: (body.location as string) || job.location,
      work_model: (body.work_model as string) || job.work_model,
      comp_text: (body.comp as string) || job.comp_text,
      scores_json: body.scores_json ? (body.scores_json as string) : job.scores_json,
      company_url: (body.company_url as string) || job.company_url,
      job_url: (body.job_url as string) || job.job_url,
    });
    const updated = await getJob(env, id);
    await updateMsg(env, channelId, cardTs, `${updated!.company ?? ''} — ${updated!.role ?? ''}`, createCard(updated!));
    await refreshHome();
  }

  if (body.type === 'research') {
    await updateJob(env, id, {
      in_flight: null,
      research_summary: (body.summary as string) || null,
      research_signals_json: (body.signals_json as string) || null,
      research_sources_json: (body.sources_json as string) || null,
      brief_key: (body.brief_key as string) || job.brief_key,
      research_level: 'deep',
    });
    const updated = await getJob(env, id);
    await updateMsg(env, channelId, cardTs, 'Research complete', createCard(updated!));

    if (body.brief_key && rootTs) {
      await uploadToThread(env, body.brief_key as string, channelId, rootTs, 'Research Brief', (body.summary as string) || 'Research complete.');
    } else if (body.summary && rootTs) {
      await postMsg(env, channelId, body.summary as string, undefined, rootTs);
    }

    await refreshHome();
  }

  if (body.type === 'tailor' || body.type === 'refine') {
    await updateJob(env, id, {
      in_flight: null,
      resume_pdf_key: (body.resume_pdf_key as string) || job.resume_pdf_key,
    });
    const updated = await getJob(env, id);
    await updateMsg(env, channelId, cardTs, 'Tailoring complete', createCard(updated!));

    if (body.resume_pdf_key && rootTs) {
      await uploadToThread(env, body.resume_pdf_key as string, channelId, rootTs, 'Tailored Resume', (body.decisions as string) || 'Tailoring complete.');
    }

    await refreshHome();
  }

  if (body.type === 'apply') {
    await updateJob(env, id, {
      in_flight: null,
      stage: 'APPLIED',
      apply_pending_json: null,
    });
    const updated = await getJob(env, id);
    await updateMsg(env, channelId, cardTs, 'Application submitted', createCard(updated!));
    await refreshHome();
  }

  if (body.type === 'apply_needs_input') {
    await updateJob(env, id, {
      in_flight: null,
      apply_pending_json: JSON.stringify(body.questions),
    });
    if (job.channel_id && job.root_ts) {
      await postMsg(env, job.channel_id, 'Action needed to complete your application:', undefined, job.root_ts);
    }
    await refreshHome();
  }

  return new Response(JSON.stringify({ ok: true }), createResponseInit('json'));
}
