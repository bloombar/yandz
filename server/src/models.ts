/**
 * Mongoose models. One module so relationships and indexes are visible together.
 * Patches are embedded in a Version (a Version IS an ordered patch set).
 */
import { Schema, model, type InferSchemaType, Types } from 'mongoose';

// --- User -----------------------------------------------------------------
const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String }, // absent for Google-only accounts
    googleId: { type: String, index: true, sparse: true },
    // Reddit-style handle, shown as u/handle everywhere. No avatars.
    handle: { type: String, required: true, unique: true, trim: true },
    handleLower: { type: String, required: true, unique: true, lowercase: true },
  },
  { timestamps: true },
);
export const User = model('User', userSchema);

// --- Page -----------------------------------------------------------------
const pageSchema = new Schema(
  {
    urlKey: { type: String, required: true, unique: true, index: true },
    urlOriginal: { type: String, required: true },
    title: { type: String, default: '' },
    versionCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const Page = model('Page', pageSchema);

// --- Version (embeds Patches) --------------------------------------------
const elementTargetSchema = new Schema(
  {
    cssSelector: String,
    xpath: String,
    textFingerprint: String,
    attrFingerprint: { type: Map, of: String },
    domPath: String,
    boundingHintPct: {
      xPct: Number,
      yPct: Number,
      wPct: Number,
      hPct: Number,
    },
  },
  { _id: false },
);

const patchSchema = new Schema(
  {
    op: {
      type: String,
      required: true,
      enum: ['textReplace', 'imageSwap', 'cssOverride', 'attrChange', 'drawingOverlay', 'annotation'],
    },
    target: { type: elementTargetSchema, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    order: { type: Number, required: true },
    // Personal application scope (see shared PatchScope): 'page' applies only on this
    // version's page; 'site'/'global' also auto-apply for the author across the host /
    // all sites.
    scope: { type: String, enum: ['page', 'site', 'global'], default: 'page' },
  },
  { _id: false },
);

const versionSchema = new Schema(
  {
    pageId: { type: Types.ObjectId, ref: 'Page', required: true, index: true },
    authorId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, default: 'Untitled version' },
    patches: { type: [patchSchema], default: [] },
    parentVersionId: { type: Types.ObjectId, ref: 'Version', default: null },
    rootVersionId: { type: Types.ObjectId, ref: 'Version', default: null },
    urlMatch: {
      mode: { type: String, enum: ['exact', 'path', 'pattern'], default: 'exact' },
      value: String,
    },
    up: { type: Number, default: 0 },
    down: { type: Number, default: 0 },
    hotScore: { type: Number, default: 0, index: true },
    wilsonScore: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const Version = model('Version', versionSchema);

// --- Vote -----------------------------------------------------------------
const voteSchema = new Schema(
  {
    versionId: { type: Types.ObjectId, ref: 'Version', required: true },
    userId: { type: Types.ObjectId, ref: 'User', required: true },
    value: { type: Number, enum: [1, -1], required: true },
  },
  { timestamps: true },
);
voteSchema.index({ versionId: 1, userId: 1 }, { unique: true });
export const Vote = model('Vote', voteSchema);

// --- Comment (threaded, per version) -------------------------------------
const commentSchema = new Schema(
  {
    versionId: { type: Types.ObjectId, ref: 'Version', required: true, index: true },
    authorId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    parentCommentId: { type: Types.ObjectId, ref: 'Comment', default: null },
    body: { type: String, required: true },
  },
  { timestamps: true },
);
export const Comment = model('Comment', commentSchema);

// --- Social graph: Follow / Mute / Block ---------------------------------
const followSchema = new Schema(
  { followerId: { type: Types.ObjectId, ref: 'User', required: true }, followeeId: { type: Types.ObjectId, ref: 'User', required: true } },
  { timestamps: true },
);
followSchema.index({ followerId: 1, followeeId: 1 }, { unique: true });
export const Follow = model('Follow', followSchema);

const muteSchema = new Schema(
  { muterId: { type: Types.ObjectId, ref: 'User', required: true }, mutedId: { type: Types.ObjectId, ref: 'User', required: true } },
  { timestamps: true },
);
muteSchema.index({ muterId: 1, mutedId: 1 }, { unique: true });
export const Mute = model('Mute', muteSchema);

const blockSchema = new Schema(
  { blockerId: { type: Types.ObjectId, ref: 'User', required: true }, blockedId: { type: Types.ObjectId, ref: 'User', required: true } },
  { timestamps: true },
);
blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
export const Block = model('Block', blockSchema);

// --- Bookmark (a user's saved version) -----------------------------------
const bookmarkSchema = new Schema(
  { userId: { type: Types.ObjectId, ref: 'User', required: true }, versionId: { type: Types.ObjectId, ref: 'Version', required: true } },
  { timestamps: true },
);
bookmarkSchema.index({ userId: 1, versionId: 1 }, { unique: true });
export const Bookmark = model('Bookmark', bookmarkSchema);

// --- Push subscriptions ---------------------------------------------------
const pushSubSchema = new Schema(
  {
    userId: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    subscription: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);
export const PushSub = model('PushSub', pushSubSchema);

export type UserDoc = InferSchemaType<typeof userSchema>;
export type VersionDoc = InferSchemaType<typeof versionSchema>;
export type CommentDoc = InferSchemaType<typeof commentSchema>;
