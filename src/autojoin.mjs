// 공개 채널 자동 참여. 🌐 반응 이벤트는 봇이 들어가 있는 채널에서만 오기 때문에,
// 시작할 때 모든 공개 채널에 들어가고, 새로 생기거나 보관 해제된 공개 채널에도 바로 들어간다.
// 비공개 채널은 Slack 구조상 봇이 스스로 들어갈 수 없다(사람이 /invite 해야 함).
// 필요한 Bot scope: channels:read, channels:join. 이벤트: channel_created, channel_unarchive.

// 한 채널에 들어간다. 이미 들어가 있거나 보관된 채널이면 조용히 넘어간다.
export async function joinChannel(client, channelId, logger) {
  try {
    await client.conversations.join({ channel: channelId });
    return 'joined';
  } catch (err) {
    const code = err?.data?.error ?? err?.code ?? 'unknown';
    if (code === 'already_in_channel' || code === 'is_archived' || code === 'method_not_supported_for_channel_type') {
      return 'skipped';
    }
    logger?.warn?.(`[autojoin] ${channelId} 참여 실패: ${code}`);
    return 'failed';
  }
}

// 봇이 아직 없는 공개 채널(보관 제외)에 모두 들어간다.
export async function joinAllPublicChannels(client, logger) {
  const result = { joined: 0, skipped: 0, failed: 0 };
  let cursor;
  do {
    const res = await client.conversations.list({
      types: 'public_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });
    for (const ch of res.channels ?? []) {
      if (ch.is_member || ch.is_archived) { result.skipped += 1; continue; }
      result[await joinChannel(client, ch.id, logger)] += 1;
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return result;
}

export function registerAutoJoin(app, { logger }) {
  // 새 공개 채널. (비공개 채널 생성은 봇에게 이벤트가 오지 않는다.)
  app.event('channel_created', async ({ event, client }) => {
    const id = event?.channel?.id;
    if (id) await joinChannel(client, id, logger);
  });
  // 보관했다가 다시 살린 공개 채널.
  app.event('channel_unarchive', async ({ event, client }) => {
    if (event?.channel) await joinChannel(client, event.channel, logger);
  });
}
