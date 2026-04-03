declare module 'google-trends-api' {
  interface TrendsOptions {
    keyword: string | string[];
    startTime?: Date;
    endTime?: Date;
    geo?: string;
    hl?: string;
    category?: number;
    property?: string;
    granularTimeResolution?: boolean;
  }

  const googleTrends: {
    interestOverTime(options: TrendsOptions): Promise<string>;
    interestByRegion(options: TrendsOptions): Promise<string>;
    relatedQueries(options: TrendsOptions): Promise<string>;
    relatedTopics(options: TrendsOptions): Promise<string>;
    dailyTrends(options: { geo: string; trendDate?: Date }): Promise<string>;
    realTimeTrends(options: { geo: string; category?: string }): Promise<string>;
  };

  export default googleTrends;
}
