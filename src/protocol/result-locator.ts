import { z } from "zod";
import { sha256Digest } from "./limits.js";

export const CommentResultLocatorSchema = z
  .object({
    kind: z.literal("issue-comment"),
    commentId: z.string().min(1).max(200),
    receiptDigest: sha256Digest,
  })
  .strict();
export type CommentResultLocator = z.infer<typeof CommentResultLocatorSchema>;
