// ---- Interactivity handler (/slack/interactivity) ------------------------
// Handles all block_actions (button clicks) and view_submission (modal submits).

import type { Env, JobRow } from '../types';
import { getJob, updateJob, getCompanyResearchLevel } from '../db';
import { cardBlocks, deepResearchModal, refineModal, jobDetailModal } from '../blocks';
import { safeUpdateCard, updateMsg, deleteMsg, openModal, publishHome, wakeAgent, moveThread } from '../slack';

export async function handleInteractivity(env: Env, payload: Record<string, unknown>): Promise<void> {
  const userId = (payload.user as Record<string, string>)?.id ?? '';

  // ---- Modal submissions --------------------------------------------------
  if (payload.type === 'view_submission') {
    const view = payload.view as Record<string, unknown>;
    const jobId = view.private_metadata as string;
    const values = (view.state as Record<string, unknown>).values as
      Record<string, Record<string, { selected_options?: Array<{ value: string }>; value?: string }>>;

    if (view.callback_id === 'deep_research_modal') {
      const facets = (values.facets?.facets_input?.selected_options ?? []).map(o => o.value);
      const extra = values.extra?.extra_input?.value ?? '';
      const job = await getJob(env, jobId);
      if (!job?.channel_id || !job.card_ts) return;

      // Pass any existing company research so the agent can skip redundant work.
      const companyResearch = job.company_id ? await getCompanyResearchLevel(env, job.company_id) : null;

      await updateJob(env, jobId, { status: 'researching', research_level: 'deep', research_facets: JSON.stringify({ facets, extra }), queued_next: 'none' });
      const updated = await getJob(env, jobId);
      await safeUpdateCard(env, updated!, 'Researching…', cardBlocks(updated!));
      await wakeAgent(env, 'deep_research', jobId, {
        facets,
        extra,
        company_research_level: companyResearch ?? 'none',
        ...(job.company_id ? { company_id: job.company_id } : {}),
      });
      await publishHome(env, userId);
    }

    if (view.callback_id === 'refine_modal') {
      const feedback = values.feedback?.feedback_input?.value ?? '';
      const job = await getJob(env, jobId);
      if (!job?.channel_id || !job.card_ts) return;

      await updateJob(env, jobId, { status: 'tailoring', tailor_state: 'in_progress' });
      const updated = await getJob(env, jobId);
      await safeUpdateCard(env, updated!, 'Tailoring…', cardBlocks(updated!));
      await wakeAgent(env, 'refine', jobId, { feedback });
      await publishHome(env, userId);
    }

    // job_detail_modal has no submit button — close-only, nothing to handle
    return;
  }

  // ---- Button / overflow clicks -------------------------------------------
  if (payload.type === 'block_actions') {
    const actions = payload.actions as Array<Record<string, unknown>>;
    const action = actions[0];
    const actionId = action.action_id as string;
    const triggerId = payload.trigger_id as string;
    const container = payload.container as Record<string, string> | undefined;

    // /jobs board overflow menu
    if (actionId === 'jobs_overflow') {
      const selected = (action.selected_option as Record<string, string>).value;
      const [act, ovJobId] = selected.split(':');
      const job = await getJob(env, ovJobId);
      if (!job) return;

      if (act === 'stage' && env.STAGE_CHANNEL) {
        await updateJob(env, ovJobId, { status: 'staging' });
        const updated = await getJob(env, ovJobId);
        await safeUpdateCard(env, updated!, 'Moving…', cardBlocks(updated!));
        await moveThread(env, updated!, env.STAGE_CHANNEL);
      } else if (act === 'park' && env.PARKING_LOT_CHANNEL) {
        await updateJob(env, ovJobId, { status: 'parking' });
        const updated = await getJob(env, ovJobId);
        await safeUpdateCard(env, updated!, 'Parking…', cardBlocks(updated!));
        await moveThread(env, updated!, env.PARKING_LOT_CHANNEL);
      } else if (act === 'delete') {
        if (job.card_ts && job.channel_id) await deleteMsg(env, job.channel_id, job.card_ts).catch(() => {});
        if (job.root_ts && job.channel_id) await deleteMsg(env, job.channel_id, job.root_ts).catch(() => {});
        await env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(ovJobId).run();
      }
      await publishHome(env, userId);
      return;
    }

    // All job card / home row buttons carry job id as value
    const jobId = action.value as string;
    const job = await getJob(env, jobId);
    if (!job) return;

    // Helper: update card and always refresh home.
    // safeUpdateCard re-posts the card into the thread if the message was deleted.
    const refresh = async (updated: JobRow | null, text: string) => {
      if (updated && container?.type !== 'view') {
        await safeUpdateCard(env, updated, text, cardBlocks(updated));
      }
      await publishHome(env, userId);
    };

    switch (actionId) {
      case 'job_view_modal': {
        await openModal(env, triggerId, jobDetailModal(job));
        break;
      }

      case 'job_research': {
        await updateJob(env, jobId, { status: 'research_depth_select' });
        await refresh(await getJob(env, jobId), 'Choose depth');
        break;
      }

      case 'job_research_deep': {
        // Modal opens synchronously; DB/card update waits until after modal submit
        await openModal(env, triggerId, deepResearchModal(jobId, job.company ?? ''));
        break;
      }

      case 'job_research_surface': {
        // Pass any existing company research so the agent can skip redundant company work.
        const companyResearch = job.company_id ? await getCompanyResearchLevel(env, job.company_id) : null;
        await updateJob(env, jobId, { status: 'researching', research_level: 'surface', queued_next: 'none' });
        await refresh(await getJob(env, jobId), 'Researching…');
        await wakeAgent(env, 'surface_research', jobId, {
          company_research_level: companyResearch ?? 'none',
          ...(job.company_id ? { company_id: job.company_id } : {}),
        });
        break;
      }

      case 'job_tailor': {
        await updateJob(env, jobId, { status: 'tailoring', tailor_state: 'in_progress', queued_next: 'none' });
        await refresh(await getJob(env, jobId), 'Tailoring…');
        await wakeAgent(env, 'tailor', jobId);
        break;
      }

      case 'job_refine': {
        await openModal(env, triggerId, refineModal(jobId, job.company ?? '', job.role ?? ''));
        break;
      }

      case 'job_queue_tailor': {
        await updateJob(env, jobId, { queued_next: 'tailor_after_research' });
        await refresh(await getJob(env, jobId), 'Research + Tailor queued');
        break;
      }

      case 'job_queue_stage': {
        await updateJob(env, jobId, { queued_next: 'stage_after_tailor' });
        await refresh(await getJob(env, jobId), 'Stage queued');
        break;
      }

      case 'job_unqueue_stage': {
        await updateJob(env, jobId, { queued_next: 'none' });
        await refresh(await getJob(env, jobId), 'Stage unqueued');
        break;
      }

      case 'job_park': {
        if (!env.PARKING_LOT_CHANNEL) break;
        await updateJob(env, jobId, { status: 'parking' });
        await refresh(await getJob(env, jobId), 'Parking…');
        await moveThread(env, (await getJob(env, jobId))!, env.PARKING_LOT_CHANNEL);
        await publishHome(env, userId); // moveThread changes status to parked — re-render
        break;
      }

      case 'job_stage': {
        if (!env.STAGE_CHANNEL) break;
        await updateJob(env, jobId, { status: 'staging' });
        await refresh(await getJob(env, jobId), 'Staging…');
        await moveThread(env, (await getJob(env, jobId))!, env.STAGE_CHANNEL);
        await publishHome(env, userId);
        break;
      }
    }
  }
}
