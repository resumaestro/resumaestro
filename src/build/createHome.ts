import type {
  ActionsBlock,
  Button,
  ContextBlock,
  KnownBlock,
  Option,
  Overflow,
  SectionBlock,
  StaticSelect,
} from '@slack/types';
import type { JobRow, ListView, ListOptions } from '#/types';
import { createButton, createDivider, createMarkdown, createPlainText } from './blocks/primitives';

type Stage = 'IDLE' | 'APPLIED' | 'INTERVIEWING' | 'OFFERED';

const STAGE_ORDER: Stage[] = ['IDLE', 'APPLIED', 'INTERVIEWING', 'OFFERED'];

function createNavButtons(view: ListView): Button[] {
  if (view === 'jobs') {
    return [
      createButton('Pipeline →', 'home_tab:pipeline', 'pipeline'),
      createButton('Parked →', 'home_tab:parked', 'parked'),
    ];
  }
  if (view === 'pipeline') {
    return [
      createButton('Jobs →', 'home_tab:jobs', 'jobs'),
      createButton('Parked →', 'home_tab:parked', 'parked'),
    ];
  }
  return [
    createButton('Jobs →', 'home_tab:jobs', 'jobs'),
    createButton('Pipeline →', 'home_tab:pipeline', 'pipeline'),
  ];
}

function createSortFilterRow(view: ListView): ActionsBlock {
  const sortSelect: StaticSelect = {
    type: 'static_select',
    action_id: `home_sort:${view}`,
    placeholder: createPlainText('Sort'),
    options: [
      { text: createPlainText('Recently Updated'), value: 'updated' } satisfies Option,
      { text: createPlainText('Date Added'), value: 'created' } satisfies Option,
    ],
  };

  const filterSelect: StaticSelect = {
    type: 'static_select',
    action_id: `home_filter:work_model:${view}`,
    placeholder: createPlainText('Work Model'),
    options: [
      { text: createPlainText('All'), value: 'all' } satisfies Option,
      { text: createPlainText('Remote'), value: 'remote' } satisfies Option,
      { text: createPlainText('Hybrid'), value: 'hybrid' } satisfies Option,
      { text: createPlainText('Onsite'), value: 'onsite' } satisfies Option,
    ],
  };

  return { type: 'actions', elements: [sortSelect, filterSelect] } satisfies ActionsBlock;
}

function createInFlightText(job: JobRow): string {
  switch (job.in_flight) {
    case 'SCORING':
      return '_Scanning listing…_';
    case 'RESEARCHING':
      return '_Researching…_';
    case 'TAILORING':
      return '_Tailoring…_';
    case 'APPLYING':
      return '_Applying…_';
    default:
      return '';
  }
}

function createIdleSummary(job: JobRow): string {
  const parts: string[] = [];

  if (job.research_level === 'deep') {
    parts.push('Deep research ✓');
  } else if (job.research_level === 'surface') {
    parts.push('Surface research ✓');
  }

  if (job.tailor_state === 'done') {
    parts.push('Tailored ✓');
  }

  return parts.length > 0 ? parts.join('  ·  ') : '_No research yet_';
}

function createJobRow(job: JobRow, view: 'jobs' | 'pipeline'): KnownBlock[] {
  const company = job.company ?? 'Unknown Company';
  const role = job.role ?? 'Unknown Role';
  const id = job.id;

  const titleParts: string[] = [`*${company}* — ${role}`];
  if (job.work_model) {
    titleParts.push(job.work_model);
  }
  if (job.comp_text) {
    titleParts.push(job.comp_text);
  }
  const titleText = titleParts.join('  ·  ');

  let overflow: Overflow;

  if (view === 'jobs') {
    const viewDetailsOption: Option = { text: createPlainText('View Details'), value: `view:${id}` };
    const parkOption: Option = { text: createPlainText('Park'), value: `park:${id}` };
    const deleteOption: Option = { text: createPlainText('Delete'), value: `delete:${id}` };
    overflow = {
      type: 'overflow',
      action_id: 'jobs_overflow',
      options: [viewDetailsOption, parkOption, deleteOption],
    } satisfies Overflow;
  } else {
    const viewDetailsOption: Option = { text: createPlainText('View Details'), value: `view:${id}` };
    const interviewingOption: Option = { text: createPlainText('→ Interviewing'), value: `interviewing:${id}` };
    const offeredOption: Option = { text: createPlainText('→ Offered'), value: `offered:${id}` };
    const removeOption: Option = { text: createPlainText('Remove from Pipeline'), value: `pipeline_remove:${id}` };
    const deleteOption: Option = { text: createPlainText('Delete'), value: `delete:${id}` };
    overflow = {
      type: 'overflow',
      action_id: 'jobs_overflow',
      options: [viewDetailsOption, interviewingOption, offeredOption, removeOption, deleteOption],
    } satisfies Overflow;
  }

  const sectionBlock: SectionBlock = {
    type: 'section',
    text: createMarkdown(titleText),
    accessory: overflow,
  };

  let contextText: string;
  if (job.in_flight !== null) {
    contextText = createInFlightText(job);
  } else if (view === 'pipeline') {
    const stageSuffix = job.stage ? `Stage: ${job.stage}` : '';
    const idleSummary = createIdleSummary(job);
    contextText = [idleSummary, stageSuffix].filter(Boolean).join('  ·  ');
  } else {
    contextText = createIdleSummary(job);
  }

  const contextBlock: ContextBlock = {
    type: 'context',
    elements: [createMarkdown(contextText)],
  };

  const blocks: KnownBlock[] = [sectionBlock, contextBlock];

  if (job.in_flight === null) {
    const actionElements: Button[] = [];

    if (view === 'jobs') {
      if (job.research_level === 'none') {
        actionElements.push(createButton('Research', 'job_research_deep', id));
      } else if (job.tailor_state !== 'done') {
        actionElements.push(createButton('Tailor', 'job_tailor', id, { style: 'primary' }));
      } else {
        actionElements.push(createButton('Refine', 'job_refine', id, { style: 'primary' }));
      }
    } else if (view === 'pipeline' && job.stage === 'IDLE') {
      actionElements.push(createButton('Apply', 'job_apply', id));
    }

    if (actionElements.length > 0) {
      const actionsBlock: ActionsBlock = { type: 'actions', elements: actionElements };
      blocks.push(actionsBlock);
    }
  }

  return blocks;
}

function createParkedRow(job: JobRow): KnownBlock[] {
  const company = job.company ?? 'Unknown Company';
  const role = job.role ?? 'Unknown Role';
  const id = job.id;

  const restoreOption: Option = { text: createPlainText('Restore'), value: `restore:${id}` };
  const deleteOption: Option = { text: createPlainText('Delete'), value: `delete:${id}` };

  const overflow: Overflow = {
    type: 'overflow',
    action_id: 'jobs_overflow',
    options: [restoreOption, deleteOption],
  } satisfies Overflow;

  const sectionBlock: SectionBlock = {
    type: 'section',
    text: createMarkdown(`🅿 *${company}* — ${role}`),
    accessory: overflow,
  };

  return [sectionBlock];
}

export function createHome(jobs: JobRow[], view: ListView, options?: ListOptions): KnownBlock[] {
  if (view === 'jobs') {
    return createJobsView(jobs);
  }
  if (view === 'pipeline') {
    return createPipelineView(jobs);
  }
  return createParkedView(jobs);
}

function createJobsView(jobs: JobRow[]): KnownBlock[] {
  const navButtons = createNavButtons('jobs');

  const headerBlock: SectionBlock = {
    type: 'section',
    text: createMarkdown(`*Jobs*  •  ${jobs.length} active`),
  };

  const navBlock: ActionsBlock = { type: 'actions', elements: navButtons };

  const blocks: KnownBlock[] = [headerBlock, navBlock, createSortFilterRow('jobs')];

  if (jobs.length === 0) {
    blocks.push(createMarkdown('_No active jobs. Use /add {url} to get started._', { withSection: true }));
    return blocks;
  }

  const inFlight = jobs.filter(job => job.in_flight !== null);
  const idle = jobs.filter(job => job.in_flight === null);

  if (inFlight.length > 0) {
    blocks.push(createMarkdown('_⚡ In Flight_', { withSection: true }));
    blocks.push(createDivider());
    for (const job of inFlight) {
      blocks.push(...createJobRow(job, 'jobs'));
    }
  }

  blocks.push(createDivider());
  for (const job of idle) {
    blocks.push(...createJobRow(job, 'jobs'));
  }

  return blocks;
}

function createPipelineView(jobs: JobRow[]): KnownBlock[] {
  const navButtons = createNavButtons('pipeline');

  const headerBlock: SectionBlock = {
    type: 'section',
    text: createMarkdown(`*Pipeline*  •  ${jobs.length} jobs`),
  };

  const navBlock: ActionsBlock = { type: 'actions', elements: navButtons };

  const blocks: KnownBlock[] = [headerBlock, navBlock];

  if (jobs.length === 0) {
    blocks.push(createMarkdown('_No jobs in pipeline yet. Stage a job from the Jobs view._', { withSection: true }));
    return blocks;
  }

  for (const stage of STAGE_ORDER) {
    const stageJobs = jobs.filter(job => job.stage === stage);
    if (stageJobs.length === 0) {
      continue;
    }

    const stageHeader: SectionBlock = {
      type: 'section',
      text: createMarkdown(`*${stage}*`),
    };
    blocks.push(stageHeader);
    blocks.push(createDivider());

    for (const job of stageJobs) {
      blocks.push(...createJobRow(job, 'pipeline'));
    }
  }

  return blocks;
}

function createParkedView(jobs: JobRow[]): KnownBlock[] {
  const navButtons = createNavButtons('parked');

  const headerBlock: SectionBlock = {
    type: 'section',
    text: createMarkdown(`*Parking Lot*  •  ${jobs.length} jobs`),
  };

  const navBlock: ActionsBlock = { type: 'actions', elements: navButtons };

  const blocks: KnownBlock[] = [headerBlock, navBlock];

  if (jobs.length === 0) {
    blocks.push(createMarkdown('_Nothing parked._', { withSection: true }));
    return blocks;
  }

  for (const job of jobs) {
    blocks.push(...createParkedRow(job));
  }

  return blocks;
}
