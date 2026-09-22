import rawData from '../data/industry-etf.json';

export interface ETFItem {
  code: string;
  name: string;
  market: string;
  subTheme: string;
  remark: string;
}

export interface IndustryGroup {
  id: string;
  index: string;
  name: string;
  count: number;
  items: ETFItem[];
}

export const industryGroups: IndustryGroup[] = rawData as IndustryGroup[];

export const totalETFCount = industryGroups.reduce((sum, g) => sum + g.count, 0);
