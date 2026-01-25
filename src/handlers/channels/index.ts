/**
 * Channel Handlers Index
 *
 * 各メッセージングチャネルのハンドラをエクスポート
 */

export * from './telegram';
export * from './whatsapp';

export { default as telegramHandler } from './telegram';
export { default as whatsappHandler } from './whatsapp';
