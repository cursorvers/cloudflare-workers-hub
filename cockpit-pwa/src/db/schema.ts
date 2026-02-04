import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// Cockpit Tasks
export const cockpitTasks = sqliteTable('cockpit_tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status', { enum: ['todo', 'in_progress', 'done', 'blocked'] })
    .notNull()
    .default('todo'),
  priority: text('priority', { enum: ['low', 'medium', 'high', 'urgent'] })
    .notNull()
    .default('medium'),
  assignee: text('assignee'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Git Repositories
export const cockpitGitRepos = sqliteTable('cockpit_git_repos', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  url: text('url').notNull(),
  branch: text('branch').notNull().default('main'),
  lastCommit: text('last_commit'),
  lastSync: integer('last_sync', { mode: 'timestamp' }),
  status: text('status', { enum: ['active', 'inactive', 'error'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Alerts
export const cockpitAlerts = sqliteTable('cockpit_alerts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  severity: text('severity', { enum: ['info', 'warning', 'error', 'critical'] })
    .notNull()
    .default('info'),
  message: text('message').notNull(),
  source: text('source'),
  acknowledged: integer('acknowledged', { mode: 'boolean' })
    .notNull()
    .default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Audit Logs
export const cockpitAuditLogs = sqliteTable('cockpit_audit_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  action: text('action').notNull(), // 'create', 'update', 'delete', 'status_change'
  entityType: text('entity_type').notNull(), // 'task', 'repo', 'alert'
  entityId: text('entity_id').notNull(),
  changes: text('changes'), // JSON string of changes
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Push Subscriptions (Web Push API)
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  endpoint: text('endpoint').notNull().unique(),
  auth: text('auth').notNull(), // keys.auth (base64)
  p256dh: text('p256dh').notNull(), // keys.p256dh (base64)
  userId: text('user_id'), // Optional: link to user (for multi-user support)
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Export types
export type Task = typeof cockpitTasks.$inferSelect;
export type NewTask = typeof cockpitTasks.$inferInsert;
export type GitRepo = typeof cockpitGitRepos.$inferSelect;
export type NewGitRepo = typeof cockpitGitRepos.$inferInsert;
export type Alert = typeof cockpitAlerts.$inferSelect;
export type NewAlert = typeof cockpitAlerts.$inferInsert;
export type AuditLog = typeof cockpitAuditLogs.$inferSelect;
export type NewAuditLog = typeof cockpitAuditLogs.$inferInsert;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;
