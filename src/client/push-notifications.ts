/**
 * PWA Push Notifications Client SDK
 *
 * Usage:
 * ```typescript
 * import { PushNotificationManager } from './push-notifications';
 *
 * const manager = new PushNotificationManager('/api/cockpit', {
 *   onLoadingStart: () => showSpinner(),
 *   onLoadingEnd: () => hideSpinner(),
 * });
 * await manager.initialize();
 * await manager.detectIOSAndPromptA2HS();
 * const permission = await manager.requestPermission();
 * if (permission === 'granted') {
 *   await manager.subscribe();
 * }
 * ```
 */

export interface PushSubscriptionInfo {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export type PermissionState = 'granted' | 'denied' | 'default';

export interface PushNotificationManagerOptions {
  onLoadingStart?: () => void;
  onLoadingEnd?: () => void;
}

/**
 * Dark mode contrast guidance for host UI around push prompts.
 * Ratios meet WCAG 2.1 AA for normal (4.5:1) and large text (3:1).
 */
export const PUSH_NOTIFICATION_DARK_MODE_CONTRAST = {
  background: '#0f172a',
  textPrimary: '#f8fafc',
  textSecondary: '#94a3b8',
  contrastRatioPrimary: '17.06:1',
  contrastRatioSecondary: '6.96:1',
  notes: 'Use with native dialogs or host UI for accessible dark mode contrast.',
} as const;

interface VapidPublicKeyResponse {
  publicKey: string;
}

interface SubscribeResponse {
  success: boolean;
  message?: string;
}

export class PushNotificationManager {
  private registration: ServiceWorkerRegistration | null = null;
  private apiBaseUrl: string;
  private onLoadingStart?: () => void;
  private onLoadingEnd?: () => void;

  constructor(
    apiBaseUrl: string = '/api/cockpit',
    options: PushNotificationManagerOptions = {}
  ) {
    this.apiBaseUrl = apiBaseUrl;
    this.onLoadingStart = options.onLoadingStart;
    this.onLoadingEnd = options.onLoadingEnd;
  }

  /**
   * Initialize Service Worker and check current state
   */
  async initialize(): Promise<boolean> {
    if (!('serviceWorker' in navigator)) {
      console.error('[PushManager] Service Worker not supported');
      return false;
    }

    if (!('PushManager' in window)) {
      console.error('[PushManager] Push API not supported');
      return false;
    }

    try {
      // Register Service Worker
      this.registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
      });

      console.log('[PushManager] Service Worker registered:', this.registration.scope);

      // Wait for Service Worker to be active
      await navigator.serviceWorker.ready;

      return true;
    } catch (error) {
      console.error('[PushManager] Service Worker registration failed:', error);
      return false;
    }
  }

  /**
   * Get current notification permission state
   */
  getPermissionState(): PermissionState {
    if (!('Notification' in window)) {
      return 'denied';
    }
    return Notification.permission as PermissionState;
  }

  /**
   * Check if push notifications are supported and enabled
   */
  async isSupported(): Promise<boolean> {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return false;
    }

    const permission = this.getPermissionState();
    return permission !== 'denied';
  }

  /**
   * Check if user is currently subscribed
   */
  async isSubscribed(): Promise<boolean> {
    if (!this.registration) {
      return false;
    }

    try {
      const subscription = await this.registration.pushManager.getSubscription();
      return subscription !== null;
    } catch (error) {
      console.error('[PushManager] Failed to check subscription:', error);
      return false;
    }
  }

  /**
   * Request notification permission from user
   */
  async requestPermission(): Promise<PermissionState> {
    if (!('Notification' in window)) {
      console.error('[PushManager] Notifications not supported');
      return 'denied';
    }

    const currentPermission = this.getPermissionState();
    if (currentPermission === 'granted') {
      return 'granted';
    }

    if (currentPermission === 'denied') {
      this.showPermissionDeniedDialog();
      return 'denied';
    }

    const promptedForA2HS = await this.detectIOSAndPromptA2HS();
    if (promptedForA2HS) {
      return 'default';
    }

    const proceed = await this.showPrePermissionDialog();
    if (!proceed) {
      return 'default';
    }

    const permission = await Notification.requestPermission();
    console.log('[PushManager] Permission result:', permission);
    if (permission === 'denied') {
      this.showPermissionDeniedDialog();
    }
    return permission as PermissionState;
  }

  /**
   * Show a lightweight explanation before triggering the browser prompt.
   *
   * @example
   * ```typescript
   * const proceed = await manager.showPrePermissionDialog();
   * if (proceed) {
   *   await manager.requestPermission();
   * }
   * ```
   */
  async showPrePermissionDialog(): Promise<boolean> {
    const message = [
      'Push notifications for Cockpit',
      'We send critical alerts and operational updates only.',
      'You can change this anytime in your browser settings.',
      'Keyboard: press Enter to continue, or Esc to cancel.',
      'Continue to the browser permission prompt?',
    ].join('\n\n');

    return window.confirm(message);
  }

  /**
   * Inform the user how to re-enable notifications after a denial.
   */
  showPermissionDeniedDialog(): void {
    const steps = [
      'Notifications are blocked for this site.',
      'To re-enable notifications:',
      '1) Open browser Settings → Site settings → Notifications.',
      '2) Find this site and set it to Allow.',
      '3) Reload the app, then try enabling notifications again.',
      'Keyboard tip: use Tab and Enter to move through settings.',
    ];

    if (this.isIOSDevice() && !this.isStandaloneMode()) {
      steps.push('On iOS, add this app to your Home Screen before enabling notifications.');
    }

    steps.push('Press Enter to close this message.');
    window.alert(steps.join('\n'));
  }

  /**
   * Detect iOS and prompt users to add the app to their Home Screen.
   *
   * @example
   * ```typescript
   * await manager.detectIOSAndPromptA2HS();
   * ```
   */
  async detectIOSAndPromptA2HS(): Promise<boolean> {
    if (!this.isIOSDevice() || this.isStandaloneMode()) {
      return false;
    }

    const message = [
      'iOS requires adding this app to your Home Screen before notifications work.',
      'Steps:',
      '1) Open the Share menu in Safari (square with an arrow).',
      '2) Choose "Add to Home Screen".',
      '3) Open the app from the new icon, then enable notifications.',
      'Screen reader note: the Share action is labeled "Share" in Safari.',
      'Press Enter to close this message.',
    ].join('\n\n');

    window.alert(message);
    return true;
  }

  /**
   * Subscribe to push notifications
   */
  async subscribe(): Promise<{ success: boolean; error?: string }> {
    if (!this.registration) {
      return {
        success: false,
        error: this.formatActionableError(
          'Service Worker not initialized.',
          'Call initialize() before subscribing.'
        ),
      };
    }

    try {
      this.onLoadingStart?.();

      // Check permission
      const permission = this.getPermissionState();
      if (permission !== 'granted') {
        if (permission === 'denied') {
          this.showPermissionDeniedDialog();
        }

        const recovery = permission === 'denied'
          ? 'Enable notifications in your browser settings, then retry.'
          : 'Call requestPermission() to allow notifications, then retry.';

        return {
          success: false,
          error: this.formatActionableError('Permission not granted.', recovery),
        };
      }

      // Get existing subscription
      let subscription = await this.registration.pushManager.getSubscription();

      if (!subscription) {
        // Fetch VAPID public key from server
        const response = await fetch(`${this.apiBaseUrl}/vapid-public-key`);
        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(
            this.formatActionableError(
              `Failed to fetch VAPID key (${response.status}): ${errorText || response.statusText}`,
              'Check your network connection and server availability, then retry.'
            )
          );
        }

        const data = await response.json() as VapidPublicKeyResponse;
        if (!data || typeof data.publicKey !== 'string' || !data.publicKey) {
          throw new Error(
            this.formatActionableError(
              'Invalid VAPID key response format.',
              'Verify the server response and try again.'
            )
          );
        }

        // Create new subscription
        subscription = await this.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: this.urlBase64ToUint8Array(data.publicKey),
        });

        console.log('[PushManager] New subscription created');
      } else {
        console.log('[PushManager] Using existing subscription');
      }

      // Send subscription to server
      const subscriptionData = this.extractSubscriptionData(subscription);
      const saveResponse = await fetch(`${this.apiBaseUrl}/subscribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(subscriptionData),
      });

      if (!saveResponse.ok) {
        const errorText = await saveResponse.text().catch(() => '');
        throw new Error(
          this.formatActionableError(
            `Failed to save subscription (${saveResponse.status}): ${errorText || saveResponse.statusText}`,
            'Check your network connection and retry.'
          )
        );
      }

      const result = await saveResponse.json() as SubscribeResponse;
      if (!result || typeof result.success !== 'boolean') {
        throw new Error(
          this.formatActionableError(
            'Invalid subscribe response format.',
            'Verify the server response and try again.'
          )
        );
      }

      console.log('[PushManager] Subscription saved to server');
      return { success: true };
    } catch (error) {
      console.error('[PushManager] Subscription failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: this.ensureRecoveryHint(message),
      };
    } finally {
      this.onLoadingEnd?.();
    }
  }

  /**
   * Unsubscribe from push notifications
   */
  async unsubscribe(): Promise<{ success: boolean; error?: string }> {
    if (!this.registration) {
      return {
        success: false,
        error: this.formatActionableError(
          'Service Worker not initialized.',
          'Call initialize() before unsubscribing.'
        ),
      };
    }

    try {
      const subscription = await this.registration.pushManager.getSubscription();

      if (!subscription) {
        console.log('[PushManager] No active subscription found');
        return { success: true };
      }

      // Extract subscription data before unsubscribing
      const subscriptionData = this.extractSubscriptionData(subscription);

      // Unsubscribe from browser
      const unsubscribed = await subscription.unsubscribe();

      if (!unsubscribed) {
        throw new Error('Failed to unsubscribe from browser');
      }

      // Remove subscription from server
      const response = await fetch(`${this.apiBaseUrl}/unsubscribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ endpoint: subscriptionData.endpoint }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        console.warn(
          `[PushManager] Failed to remove subscription from server (${response.status}): ${errorText || response.statusText}`
        );
        // Continue anyway since browser unsubscribe succeeded
      } else {
        // Validate server response format
        try {
          const result = await response.json() as SubscribeResponse;
          if (result && typeof result.success === 'boolean' && !result.success) {
            console.warn('[PushManager] Server reported unsubscribe failure:', result.message);
          }
        } catch (parseError) {
          console.warn('[PushManager] Failed to parse unsubscribe response:', parseError);
        }
      }

      console.log('[PushManager] Unsubscribed successfully');
      return { success: true };
    } catch (error) {
      console.error('[PushManager] Unsubscribe failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: this.ensureRecoveryHint(message),
      };
    }
  }

  /**
   * Test notification (requires subscription)
   */
  async testNotification(): Promise<boolean> {
    const permission = this.getPermissionState();
    if (permission !== 'granted') {
      console.error('[PushManager] Permission not granted');
      return false;
    }

    try {
      const notification = new Notification('Test Notification', {
        body: 'This is a test notification from Cockpit PWA',
        icon: '/icon-192.png',
        badge: '/badge-72.png',
        tag: 'test-notification',
      });

      // Auto-close after 5 seconds
      setTimeout(() => notification.close(), 5000);

      return true;
    } catch (error) {
      console.error('[PushManager] Test notification failed:', error);
      return false;
    }
  }

  /**
   * Extract subscription data for server
   */
  private extractSubscriptionData(subscription: PushSubscription): PushSubscriptionInfo {
    const json = subscription.toJSON();
    const keys = json.keys;

    if (!keys || typeof keys !== 'object' || !keys.p256dh || !keys.auth) {
      throw new Error('Invalid subscription format: missing required keys');
    }

    return {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
    };
  }

  /**
   * Convert URL-safe base64 to Uint8Array
   */
  private urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');

    const rawData = window.atob(base64);
    const buffer = new ArrayBuffer(rawData.length);
    const outputArray = new Uint8Array(buffer);

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }

    return outputArray;
  }

  /**
   * Detect iOS devices via user agent and touch capability.
   */
  private isIOSDevice(): boolean {
    const userAgent = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(userAgent);
    const isIPadOS = /Macintosh/.test(userAgent) && navigator.maxTouchPoints > 1;
    return isIOS || isIPadOS;
  }

  /**
   * Detect if the app is running as an installed PWA.
   */
  private isStandaloneMode(): boolean {
    const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
    const isStandalone = Boolean(navigatorWithStandalone.standalone);
    const isDisplayModeStandalone = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(display-mode: standalone)').matches
      : false;

    return isStandalone || isDisplayModeStandalone;
  }

  /**
   * Append recovery hints when missing from an error message.
   */
  private ensureRecoveryHint(message: string): string {
    const lowerMessage = message.toLowerCase();
    const hasHint = [
      'try',
      'retry',
      'enable',
      'call',
      'check',
      'open',
      'reload',
      'refresh',
    ].some((hint) => lowerMessage.includes(hint));

    if (hasHint) {
      return message;
    }

    return `${message} Please try again or refresh the app.`;
  }

  /**
   * Attach actionable recovery steps to messages.
   */
  private formatActionableError(message: string, recovery: string): string {
    return `${message} ${recovery}`.trim();
  }
}

/**
 * Singleton instance for convenience
 */
let _instance: PushNotificationManager | null = null;

export function getPushNotificationManager(
  apiBaseUrl?: string,
  options?: PushNotificationManagerOptions
): PushNotificationManager {
  if (!_instance) {
    _instance = new PushNotificationManager(apiBaseUrl, options);
  }
  return _instance;
}
