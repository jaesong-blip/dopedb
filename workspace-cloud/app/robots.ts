import type { MetadataRoute } from "next";

const workspaceSiteUrl = "https://app.dopedb.dev";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: "/api/",
    },
    host: workspaceSiteUrl,
  };
}
