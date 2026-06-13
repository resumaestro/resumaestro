// ---- Slack event handler (/slack/events) ----------------------------------

import type { Env } from '../types';
import { wakeAgent, publishHome } from '../slack';

export async function handleSlackEvent(env: Env, body: Record<string, unknown>): Promise<void> {
  if (body.type !== 'event_callback') return;
  const event = body.event as Record<string, unknown>;

  if (event.type === 'app_home_opened') {
    // Render the pipeline home view for whoever opened the app home
    await publishHome(env, event.user as string);
  }

  if (event.type === 'app_mention') {
    // Forward to the Conductor agent via webhook
    await wakeAgent(env, 'mention', null, { slack_event: event, team_id: body.team_id });
  }
}
