import { Api, type TelegramClient } from "telegram";
import bigInt from "big-integer";
import type { StoragePeer } from "@teledrive/shared";
import { mapTelegramError } from "./errors.js";

const CHANNEL_TITLE = "TeleDrive Storage";
const CHANNEL_ABOUT = "Private file storage for TeleDrive. Deleting messages here deletes your files.";

/** Returns true if the channel still exists and is accessible from this account. */
async function channelAccessible(client: TelegramClient, peer: StoragePeer): Promise<boolean> {
  try {
    const result = await client.invoke(
      new Api.channels.GetChannels({
        id: [new Api.InputChannel({ channelId: bigInt(peer.channelId), accessHash: bigInt(peer.accessHash) })]
      })
    );
    return result.chats.some(chat => chat instanceof Api.Channel && chat.id.toString() === peer.channelId && !chat.left);
  } catch {
    return false;
  }
}

/**
 * Makes sure the user has a private storage channel in their own Telegram account,
 * creating one on first login (or if they deleted it).
 */
export async function ensureStorageChannel(client: TelegramClient, existing: StoragePeer | null): Promise<StoragePeer> {
  if (existing && (await channelAccessible(client, existing))) return existing;

  try {
    const result = await client.invoke(new Api.channels.CreateChannel({ title: CHANNEL_TITLE, about: CHANNEL_ABOUT, broadcast: true }));
    const chats = "chats" in result ? result.chats : [];
    const channel = chats.find((c): c is Api.Channel => c instanceof Api.Channel);
    if (!channel?.accessHash) throw new Error("Telegram did not return the created channel");
    return { channelId: channel.id.toString(), accessHash: channel.accessHash.toString() };
  } catch (err) {
    throw mapTelegramError(err);
  }
}

export interface TelegramProfile {
  telegramUserId: string;
  displayName: string;
  username: string | null;
}

export async function getProfile(client: TelegramClient): Promise<TelegramProfile> {
  const me = await client.getMe();
  const displayName = [me.firstName, me.lastName].filter(Boolean).join(" ").trim() || me.username || "Telegram user";
  return { telegramUserId: me.id.toString(), displayName, username: me.username ?? null };
}
