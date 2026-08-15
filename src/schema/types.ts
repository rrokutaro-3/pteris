// TypeScript reference types for the product schema
// Use these if you ever migrate to TS or for JSDoc comments

export type ProductType = 'physical' | 'digital' | 'service' | 'subscription' | 'bundle';
export type ProductStatus = 'active' | 'draft' | 'archived';

export interface ProductVariant {
  id: string;
  sku: string;
  barcode?: string;
  options: Record<string, string>;
  price: number;
  weight?: number;
  dimensions?: { l: number; w: number; h: number; unit: string };
  image?: string;
  stock: number;
  lowStockThreshold?: number;
  backorder?: boolean;
}

export interface ProductMediaImage {
  url: string;
  alt: string;
  type?: 'image' | '360' | 'zoom';
  order?: number;
  variant?: string | null;
}

export interface ProductMediaVideo {
  url: string;
  thumbnail?: string;
  order?: number;
}

export interface ProductUGC {
  platform: 'tiktok' | 'instagram' | 'youtube' | 'pinterest';
  url: string;
  thumbnail?: string;
  username?: string;
}

export interface ProductAttribute {
  name: string;
  value: string;
  group?: string;
  visible?: boolean;
  filterable?: boolean;
}

export interface Product {
  id: string;
  type: ProductType;
  identity: {
    name: string;
    slug: string;
    sku: string;
    barcode?: string;
    brand?: string;
    status: ProductStatus;
  };
  pricing: {
    currency: string;
    price: number;
    compareAtPrice?: number;
    costPrice?: number;
    taxClass?: string;
  };
  description: {
    short?: string;
    full?: string;
    highlights?: string[];
  };
  categories: string[];
  tags?: string[];
  attributes?: ProductAttribute[];
  variants: ProductVariant[];
  media: {
    images: ProductMediaImage[];
    videos?: ProductMediaVideo[];
  };
  ugc?: ProductUGC[];
  relations?: {
    related?: string[];
    upsells?: string[];
    crossSells?: string[];
  };
  shipping?: {
    profile?: string;
    weight?: number;
    dimensions?: { l: number; w: number; h: number; unit: string };
    requiresShipping?: boolean;
    /** ISO 3166-1 alpha-2. If set, only these countries may receive this product. */
    allowedCountries?: string[];
    /** ISO 3166-1 alpha-2. If set, these countries cannot receive this product. */
    blockedCountries?: string[];
    handlingDays?: { min?: number; max?: number };
    shipsFrom?: { country?: string; city?: string };
    note?: string;
  };
  /** Prefer product.sizeGuide over global config/size-guide.json */
  sizeGuide?: {
    title?: string;
    unit?: string;
    unitAlternates?: string[];
    note?: string;
    fitNotes?: string[];
    columns?: string[];
    rows?: Record<string, string>[];
    alternateUnitRows?: Record<string, string>[];
    howToMeasure?: { label?: string; text?: string }[];
    image?: string;
    links?: { label?: string; url?: string }[];
  };
  /** Dropship / ops info; snapshotted onto order line items at checkout */
  sourcing?: {
    sources?: { name?: string; url?: string }[];
    links?: { label?: string; url?: string }[];
    notes?: string;
  };
  seo?: {
    title?: string;
    description?: string;
    keywords?: string[];
    ogImage?: string;
    canonical?: string;
    structuredData?: Record<string, unknown>;
  };
  meta?: {
    createdAt?: string;
    updatedAt?: string;
    publishedAt?: string;
  };
}

// Index types
export interface IndexProductRef {
  name: string;
  price: number;
  image: string;
  categories: string[];
  tags: string[];
  inStock: boolean;
}

export interface IndexCategory {
  name: string;
  productIds: string[];
  heroImage?: string | null;
  description?: string;
}

export interface IndexCollection {
  name: string;
  productIds: string[];
  heroImage?: string | null;
}

export interface SearchIndexEntry {
  text: string;
  name: string;
  price: number;
  image: string;
  inStock: boolean;
}

export interface StoreIndex {
  version: string;
  productCount: number;
  products: Record<string, IndexProductRef>;
  categories: Record<string, IndexCategory>;
  collections: Record<string, IndexCollection>;
  search: Record<string, SearchIndexEntry>;
  pages: Record<string, string>;
}
