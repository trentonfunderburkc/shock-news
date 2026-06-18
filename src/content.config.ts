import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

const stories = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/stories' }),
  schema: z.object({
    title: z.string(),
    author: z.string(),
    authorId: z.number(),
    date: z.coerce.date(),
    category: z.string(),
    source_url: z.string(),
    source_name: z.string(),
    original_author: z.string().nullable().optional(),
    image: z.string(),
    image_credit: z.string(),
    comments: z
      .array(
        z.object({
          name: z.string(),
          text: z.string(),
          date: z.string(),
        })
      )
      .default([]),
    help_link: z.string().nullable().optional(),
  }),
});

export const collections = { stories };
