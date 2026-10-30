export type ForegroundServiceOptions = {
  id: number;
  title: string;
  text: string;
  icon?: string;
  channelId?: string;
  channelName?: string;
  notificationImportance?: string;
};

export const ForegroundService = {
  async startForeground(options: ForegroundServiceOptions): Promise<void> {
    console.info('[ForegroundService] startForeground', options);
  },

  async stopForeground(): Promise<void> {
    console.info('[ForegroundService] stopForeground');
  },
};
