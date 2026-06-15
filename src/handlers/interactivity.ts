import type { Env, JobRow, ResearchIntent, ListView } from '#/types';
import { getJob, updateJob } from '#/db';
import { createCard } from '#/build/createCard';
import { createDeepResearch } from '#/build/createDeepResearch';
import { createRefine } from '#/build/createRefine';
import { createJobDetail } from '#/build/createJobDetail';
import { createApply } from '#/build/createApply';
import { updateMsg, deleteMsg, openModal, publishHome, wakeAgent, slackApi } from '#/slack';

export async function handleInteractivity(env: Env, payload: Record<string, unknown>): Promise<void> {
  const userId = (payload.user as Record<string, string>)?.id ?? '';

  if (payload.type === 'view_submission') {
    await handleViewSubmission(env, payload, userId);
    return;
  }

  if (payload.type === 'block_actions') {
    await handleBlockActions(env, payload, userId);
  }
}

async function handleViewSubmission(env: Env, payload: Record<string, unknown>, userId: string): Promise<void> {
  const view = payload.view as Record<string, unknown>;
  const values = (view.state as Record<string, unknown>).values as
    Record<string, Record<string, { selected_option?: { value: string }; selected_options?: Array<{ value: string }>; value?: string }>>;

  if (view.callback_id === 'deep_research_modal') {
    await handleResearchSubmit(env, view, values, userId);
    return;
  }

  if (view.callback_id === 'apply_modal') {
    await handleApplySubmit(env, view, values, userId);
    return;
  }

  if (view.callback_id === 'refine_modal') {
    const jobId = view.private_metadata as string;
    const feedback = values.feedback?.feedback_input?.value ?? '';
    const job = await getJob(env, jobId);
    if (!job?.channel_id || !job.card_ts) {
      return;
    }
    await updateJob(env, jobId, { in_flight: 'TAILORING' });
    const updated = await getJob(env, jobId);
    await updateMsg(env, job.channel_id, job.card_ts, 'Tailoring…', createCard(updated!));
    await wakeAgent(env, 'refine', jobId, { feedback });
    await publishHome(env, userId);
  }
}

async function handleResearchSubmit(
  env: Env,
  view: Record<string, unknown>,
  values: Record<string, Record<string, { selected_option?: { value: string }; selected_options?: Array<{ value: string }>; value?: string }>>,
  userId: string,
): Promise<void> {
  let jobId: string;
  try {
    const parsed = JSON.parse(view.private_metadata as string) as Record<string, unknown>;
    jobId = parsed.jobId as string;
  } catch {
    jobId = view.private_metadata as string;
  }

  const depth = (values.research_depth?.depth_input?.selected_option?.value ?? 'standard') as ResearchIntent['depth'];
  const facets = (values.research_facets?.facets_input?.selected_options ?? []).map((option) => option.value);
  const managerName = values.manager_name?.manager_name_input?.value ?? null;
  const concern = values.concern?.concern_input?.value ?? null;

  const intent: ResearchIntent = {
    depth,
    ...(facets.length ? { facets } : {}),
    ...(managerName ? { manager_name: managerName } : {}),
    ...(concern ? { concern } : {}),
  };

  await updateJob(env, jobId, { in_flight: 'RESEARCHING', research_intent: JSON.stringify(intent) });
  await wakeAgent(env, 'deep_research', jobId, { ...intent });
  await publishHome(env, userId);
}

async function handleApplySubmit(
  env: Env,
  view: Record<string, unknown>,
  values: Record<string, Record<string, { selected_option?: { value: string }; selected_options?: Array<{ value: string }>; value?: string }>>,
  userId: string,
): Promise<void> {
  const jobId = view.private_metadata as string;
  const tone = values.cover_tone?.tone_input?.selected_option?.value;
  const emphasis = values.emphasis?.emphasis_input?.value ?? null;
  await updateJob(env, jobId, { in_flight: 'APPLYING' });
  await wakeAgent(env, 'apply', jobId, { tone, ...(emphasis ? { emphasis } : {}) });
  await publishHome(env, userId);
}

async function handleBlockActions(env: Env, payload: Record<string, unknown>, userId: string): Promise<void> {
  const actions = payload.actions as Array<Record<string, unknown>>;
  const action = actions.at(0)!;
  const actionId = action.action_id as string;
  const triggerId = payload.trigger_id as string;
  const container = payload.container as Record<string, string> | undefined;

  if (actionId.startsWith('home_tab:') || actionId.startsWith('home_sort:') || actionId.startsWith('home_filter:')) {
    await handleHomeTab(env, actionId, userId);
    return;
  }

  if (actionId === 'manager_facet_toggle') {
    await handleManagerFacetToggle(env, action, payload);
    return;
  }

  if (actionId === 'jobs_overflow') {
    const selected = (action.selected_option as Record<string, string>).value;
    const overflowAction = selected.split(':').at(0);
    const overflowJobId = selected.split(':').at(1) ?? '';
    const job = await getJob(env, overflowJobId);
    if (!job) {
      return;
    }

    if (overflowAction === 'stage') {
      await handleJobStage(env, overflowJobId, userId);
    } else if (overflowAction === 'park') {
      await handleJobPark(env, overflowJobId, userId);
    } else if (overflowAction === 'delete') {
      await handleJobDelete(env, job, userId);
    }
    return;
  }

  const jobId = action.value as string;
  const job = await getJob(env, jobId);
  if (!job) {
    return;
  }

  const channelId = container?.channel_id ?? job.channel_id ?? '';
  const cardTs = container?.message_ts ?? job.card_ts ?? '';

  switch (actionId) {
    case 'job_view_modal': {
      await handleJobViewModal(env, job, triggerId);
      break;
    }

    case 'job_research_deep': {
      await handleJobResearchDeep(env, job, triggerId);
      break;
    }

    case 'job_refine': {
      await handleJobRefine(env, job, triggerId);
      break;
    }

    case 'job_apply': {
      await handleJobApply(env, job, triggerId);
      break;
    }

    case 'job_tailor': {
      await handleJobTailor(env, jobId, channelId, cardTs, userId);
      break;
    }

    case 'job_park': {
      await handleJobPark(env, jobId, userId);
      break;
    }

    case 'job_restore': {
      await handleJobRestore(env, jobId, userId);
      break;
    }

    case 'job_stage': {
      await handleJobStage(env, jobId, userId);
      break;
    }

    case 'job_delete': {
      await handleJobDelete(env, job, userId);
      break;
    }

    case 'pipeline_remove': {
      await handlePipelineRemove(env, jobId, userId);
      break;
    }

    default: {
      if (actionId.startsWith('pipeline_advance:')) {
        const newStage = actionId.split(':').at(1) ?? '';
        await handlePipelineAdvance(env, jobId, newStage, userId);
      }
      break;
    }
  }
}

async function handleHomeTab(env: Env, actionId: string, userId: string): Promise<void> {
  if (actionId.startsWith('home_tab:')) {
    const view = actionId.slice('home_tab:'.length) as ListView;
    await publishHome(env, userId, view);
  } else if (actionId.startsWith('home_sort:')) {
    const parts = actionId.split(':');
    const field = parts.at(1) ?? '';
    const view = (parts.at(2) ?? 'jobs') as ListView;
    await publishHome(env, userId, view, { sort: field });
  } else if (actionId.startsWith('home_filter:')) {
    const parts = actionId.split(':');
    const field = parts.at(1) ?? '';
    const value = parts.at(2) ?? '';
    const view = (parts.at(3) ?? 'jobs') as ListView;
    await publishHome(env, userId, view, { filter: { [field]: value } });
  }
}

async function handleManagerFacetToggle(env: Env, action: Record<string, unknown>, payload: Record<string, unknown>): Promise<void> {
  const view = payload.view as Record<string, unknown>;
  const viewId = view.id as string;
  let privateMetadata: { jobId: string; company: string };
  try {
    privateMetadata = JSON.parse(view.private_metadata as string) as { jobId: string; company: string };
  } catch {
    return;
  }

  const selectedOptions = (action.selected_options as Array<{ value: string }>) ?? [];
  const hasManager = selectedOptions.some((option) => option.value === 'manager');
  const updatedView = createDeepResearch(privateMetadata.jobId, privateMetadata.company, hasManager);
  await slackApi(env, 'views.update', { view_id: viewId, view: updatedView });
}

async function handleJobViewModal(env: Env, job: JobRow, triggerId: string): Promise<void> {
  await openModal(env, triggerId, createJobDetail(job));
}

async function handleJobResearchDeep(env: Env, job: JobRow, triggerId: string): Promise<void> {
  await openModal(env, triggerId, createDeepResearch(job.id, job.company ?? ''));
}

async function handleJobRefine(env: Env, job: JobRow, triggerId: string): Promise<void> {
  await openModal(env, triggerId, createRefine(job.id, job.company ?? '', job.role ?? ''));
}

async function handleJobApply(env: Env, job: JobRow, triggerId: string): Promise<void> {
  await openModal(env, triggerId, createApply(job.id, job.company ?? '', job.role ?? ''));
}

async function handleJobTailor(env: Env, jobId: string, channelId: string, cardTs: string, userId: string): Promise<void> {
  await updateJob(env, jobId, { in_flight: 'TAILORING' });
  const updated = await getJob(env, jobId);
  if (updated && channelId && cardTs) {
    await updateMsg(env, channelId, cardTs, 'Tailoring…', createCard(updated));
  }
  await wakeAgent(env, 'tailor', jobId);
  await publishHome(env, userId);
}

async function handleJobPark(env: Env, jobId: string, userId: string): Promise<void> {
  await updateJob(env, jobId, { job_status: 'PARKED', stage: null });
  await publishHome(env, userId);
}

async function handleJobRestore(env: Env, jobId: string, userId: string): Promise<void> {
  await updateJob(env, jobId, { job_status: 'EVALUATING', stage: null });
  await publishHome(env, userId);
}

async function handleJobStage(env: Env, jobId: string, userId: string): Promise<void> {
  await updateJob(env, jobId, { job_status: 'STAGED', stage: 'IDLE' });
  await publishHome(env, userId);
}

async function handleJobDelete(env: Env, job: JobRow, userId: string): Promise<void> {
  if (job.card_ts && job.channel_id) {
    await deleteMsg(env, job.channel_id, job.card_ts).catch(() => {});
  }
  if (job.root_ts && job.channel_id) {
    await deleteMsg(env, job.channel_id, job.root_ts).catch(() => {});
  }
  await env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(job.id).run();
  await publishHome(env, userId);
}

async function handlePipelineAdvance(env: Env, jobId: string, newStage: string, userId: string): Promise<void> {
  await updateJob(env, jobId, { stage: newStage as JobRow['stage'] });
  await publishHome(env, userId, 'pipeline');
}

async function handlePipelineRemove(env: Env, jobId: string, userId: string): Promise<void> {
  await updateJob(env, jobId, { stage: null });
  await publishHome(env, userId);
}
