import type { Env } from '#/types';
import { wakeAgent, publishHome } from '#/slack';

export async function handleSlackEvent(env: Env, body: Record<string, unknown>): Promise<void> {
  if (body.type !== 'event_callback') {
    return;
  }
  const event = body.event as Record<string, unknown>;

  if (event.type === 'app_home_opened') {
    await publishHome(env, event.user as string);
  }

  if (event.type === 'app_mention') {
    await wakeAgent(env, 'mention', null, { slack_event: event, team_id: body.team_id });
  }
}
