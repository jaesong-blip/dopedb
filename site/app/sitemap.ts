import type { MetadataRoute } from "next";

const siteUrl = "https://dopedb.dev";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl,
      changeFrequency: "weekly",
      priority: 1,
      alternates: {
        languages: {
          en: siteUrl,
          ko: `${siteUrl}/ko`,
        },
      },
    },
    {
      url: `${siteUrl}/ko`,
      changeFrequency: "weekly",
      priority: 1,
      alternates: {
        languages: {
          en: siteUrl,
          ko: `${siteUrl}/ko`,
        },
      },
    },
    {
      url: `${siteUrl}/llms.txt`,
      changeFrequency: "monthly",
      priority: 0.8,
    },
    {
      url: `${siteUrl}/privacy`,
      changeFrequency: "yearly",
      priority: 0.5,
      alternates: {
        languages: {
          en: `${siteUrl}/privacy`,
          ko: `${siteUrl}/ko/privacy`,
        },
      },
    },
    {
      url: `${siteUrl}/ko/privacy`,
      changeFrequency: "yearly",
      priority: 0.5,
      alternates: {
        languages: {
          en: `${siteUrl}/privacy`,
          ko: `${siteUrl}/ko/privacy`,
        },
      },
    },
    {
      url: `${siteUrl}/terms`,
      changeFrequency: "yearly",
      priority: 0.5,
      alternates: {
        languages: {
          en: `${siteUrl}/terms`,
          ko: `${siteUrl}/ko/terms`,
        },
      },
    },
    {
      url: `${siteUrl}/ko/terms`,
      changeFrequency: "yearly",
      priority: 0.5,
      alternates: {
        languages: {
          en: `${siteUrl}/terms`,
          ko: `${siteUrl}/ko/terms`,
        },
      },
    },
  ];
}
