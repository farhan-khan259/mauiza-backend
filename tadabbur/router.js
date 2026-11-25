import { Router } from 'express';
import mongoose, { Schema } from 'mongoose';
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { publicStudy, registerStudyRoutes } from './study.js';
import { problem, research } from './quran.js';

const MAX_PEOPLE = 12;
const Room = mongoose.models.TadabburRoom || mongoose.model('TadabburRoom', new Schema({
  _id: String,
  inviteHash: String,
  inviteSecret: String,
  title: String,
  creatorId: String,
  scheduledAt: Number,
  duration: Number,
  startedAt: Number,
  endAt: Number,
  phase: { type: String, default: 'live' },
  study: Schema.Types.Mixed,
  revision: { type: Number, default: 0 },
  allowShare: { type: Boolean, default: true },
  members: [{
    _id: String, name: String, auth: String, role: String, joinedAt: Number,
    raised: Boolean, raisedAt: Number, removed: Boolean
  }],
  pendingRequests: [{
    _id: String, name: String, auth: String, status: String, requestedAt: Number
  }]
}, { timestamps: true, strict: false }));

const Note = mongoose.models.TadabburNote || mongoose.model('TadabburNote', new Schema({
  _id: String, room: { type: String, index: true }, owner: String,
  key: String, encrypted: String, tag: String
}, { timestamps: true }));

const token = () => randomBytes(32).toString('base64url');
const id = () => randomBytes(12).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const isToken = value => typeof value === 'string' && /^[\w-]{43}$/.test(value);
const string = (value, length) => typeof value === 'string' ? value.trim().slice(0, length) : '';
const asHandler = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
const noteId = (room, member, key) => `${room}:${member}:${key}`;
let updateRooms = () => {};

export function setRoomNotifier(notifier) {
  updateRooms = notifier;
}

function notesKey() {
  const value = process.env.TADABBUR_NOTES_KEY || '';
  if (!/^[a-f\d]{64}$/i.test(value)) {
    throw problem(503, 'The backend administrator must configure TADABBUR_NOTES_KEY as a persistent 64-character hexadecimal key before meetings can be created.');
  }
  return Buffer.from(value, 'hex');
}

function encrypt(content, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', notesKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const result = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), result]).toString('base64');
}

function decrypt(content, context) {
  const bytes = Buffer.from(content, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', notesKey(), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}

function requireStorage() {
  notesKey();
  if (mongoose.connection.readyState !== 1) throw problem(503, 'Room storage is temporarily unavailable.');
}

function mediaConfig() {
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = process.env;
  if (!url || !key || !secret) return null;
  return { url, key, secret, service: new RoomServiceClient(url.replace(/^ws/, 'http'), key, secret, { requestTimeout: 6 }) };
}

function present(room, member) {
  return {
    id: room._id, title: room.title, phase: room.phase, duration: room.duration,
    startedAt: room.startedAt || room.scheduledAt, endAt: room.endAt || room.timerEnd || 0,
    serverTime: Date.now(), revision: room.revision, study: publicStudy(room),
    members: (room.members || []).filter(person => !person.removed).map(person => ({
      id: person._id, name: person.name, role: person.role, raised: Boolean(person.raised), raisedAt: person.raisedAt || 0
    })),
    me: { id: member._id, name: member.name, role: member.role },
    pending: member._id === room.creatorId || member.role === 'host'
      ? (room.pendingRequests || []).filter(item => item.status === 'pending').map(item => ({ id: item._id, name: item.name, requestedAt: item.requestedAt }))
      : [],
    invite: (member._id === room.creatorId || member.role === 'host') && room.inviteSecret
      ? decrypt(room.inviteSecret, room._id) : undefined
  };
}

function memberFor(room, req) {
  const credentials = req.get('Authorization')?.match(/^Bearer ([\w-]{43})$/)?.[1];
  const member = credentials && room.members?.find(item => item.auth === hash(credentials));
  if (!member) throw problem(401, 'You must be admitted to this meeting.');
  return member;
}

function protect(req, room, { creator = false, allowEnded = false } = {}) {
  const member = memberFor(room, req);
  if (member.removed) throw problem(403, 'Your access to this meeting has ended.');
  if (creator && (member._id !== room.creatorId || member.role !== 'host')) {
    throw problem(403, 'Only the meeting creator can do this.');
  }
  if (room.phase === 'ended' && !allowEnded) throw problem(409, 'This meeting has ended.');
  return member;
}

function notify(req, room) {
  req.app.get('tadabburUpdates')?.(room._id);
}

async function expire(room) {
  if (room.phase !== 'live' || !room.endAt || room.endAt > Date.now()) return room;
  const ended = await Room.findOneAndUpdate(
    { _id: room._id, phase: 'live', endAt: { $lte: Date.now() } },
    { $set: { phase: 'ended' }, $inc: { revision: 1 } }, { new: true }
  );
  if (!ended) return Room.findById(room._id);
  const config = mediaConfig();
  if (config) {
    try { await config.service.deleteRoom(room._id); }
    catch (error) { if (error.code !== 'not_found') console.error('Tadabbur room expiry:', error.message); }
  }
  updateRooms(room._id);
  return ended;
}

async function roomFor(req) {
  requireStorage();
  if (!/^[a-f\d]{24}$/.test(req.params.id)) throw problem(404, 'Meeting not found.');
  let room = await Room.findById(req.params.id);
  if (!room) throw problem(404, 'Meeting not found.');
  room = await expire(room);
  return room;
}

async function write(room, changes) {
  const updated = await Room.findOneAndUpdate(
    { _id: room._id, revision: room.revision, phase: room.phase },
    { $set: changes, $inc: { revision: 1 } }, { new: true }
  );
  if (!updated) throw problem(409, 'The meeting just changed. Refresh and try again.');
  return updated;
}

async function deleteMediaRoom(roomId) {
  const config = mediaConfig();
  if (!config) return;
  try { await config.service.deleteRoom(roomId); }
  catch (error) {
    if (error.code !== 'not_found') throw problem(502, 'The media service could not close the meeting.');
  }
}

const expiryTimer = setInterval(async () => {
  if (mongoose.connection.readyState !== 1) return;
  try {
    const due = await Room.find({ phase: 'live', endAt: { $lte: Date.now() } }).select('_id phase endAt');
    await Promise.all(due.map(expire));
  } catch (error) {
    console.error('Tadabbur expiry check:', error.message);
  }
}, 1000);
expiryTimer.unref();

export async function authenticateRoomSocket({ id: roomId, auth }) {
  requireStorage();
  if (typeof roomId !== 'string' || !/^[a-f\d]{24}$/.test(roomId) || !isToken(auth)) {
    throw problem(401, 'Invalid meeting credentials.');
  }
  const room = await Room.findById(roomId).select('members phase endAt');
  const member = room?.members?.find(item => item.auth === hash(auth) && !item.removed);
  if (!member) throw problem(403, 'Only admitted participants can access meeting updates.');
  return roomId;
}

export function tadabburRouter() {
  const router = Router();
  const limits = new Map();
  const gc = setInterval(() => {
    for (const [ip, entry] of limits) if (entry.ends < Date.now()) limits.delete(ip);
  }, 60000);
  gc.unref();

  router.use((req, _res, next) => {
    const identity = req.get('Authorization')?.match(/^Bearer ([\w-]{43})$/)?.[1];
    const bucket = identity && req.path.includes('/notes') ? hash(identity) : req.ip;
    let entry = limits.get(bucket);
    if (!entry || entry.ends < Date.now()) {
      entry = { count: 0, ends: Date.now() + 60000 };
      limits.set(bucket, entry);
    }
    if (++entry.count > 240) return next(problem(429, 'Too many requests. Wait a minute and try again.'));
    next();
  });

  router.post('/rooms', asHandler(async (req, res) => {
    requireStorage();
    const name = string(req.body.name, 60), title = string(req.body.title, 100);
    const duration = Number(req.body.duration);
    if (!name || !title || !Number.isInteger(duration) || duration < 1 || duration > 180) {
      throw problem(400, 'Enter a name, meeting title, and a duration from 1 to 180 minutes.');
    }
    const invite = token();
    const auth = token();
    const roomId = id();
    const memberId = id();
    const startedAt = Date.now();
    const room = await Room.create({
      _id: roomId, title, creatorId: memberId, inviteHash: hash(invite),
      inviteSecret: encrypt(invite, roomId), duration, scheduledAt: startedAt,
      startedAt, endAt: startedAt + duration * 60000, phase: 'live',
      members: [{ _id: memberId, name, auth: hash(auth), role: 'host', joinedAt: startedAt, raised: false, removed: false }],
      pendingRequests: []
    });
    res.status(201).json({ auth, room: present(room, room.members[0]) });
  }));

  router.get('/rooms/:id/lobby', asHandler(async (req, res) => {
    const room = await roomFor(req);
    const invite = req.query.invite;
    if (!isToken(invite) || !timingSafeEqual(Buffer.from(hash(invite)), Buffer.from(room.inviteHash))) {
      throw problem(403, 'This invitation is invalid.');
    }
    res.json({ id: room._id, title: room.title, phase: room.phase, serverTime: Date.now() });
  }));

  router.post('/rooms/:id/requests', asHandler(async (req, res) => {
    const room = await roomFor(req);
    const invite = req.body.invite;
    if (!isToken(invite) || !timingSafeEqual(Buffer.from(hash(invite)), Buffer.from(room.inviteHash))) {
      throw problem(403, 'This invitation is invalid.');
    }
    if (room.phase !== 'live') throw problem(409, 'This meeting has ended.');
    const name = string(req.body.name, 60);
    if (!name) throw problem(400, 'Enter your name to request entry.');
    if ((room.members || []).filter(item => !item.removed).length >= MAX_PEOPLE) throw problem(409, 'This meeting has reached its participant limit.');
    const requestId = id();
    const auth = token();
    const pending = { _id: requestId, name, auth: hash(auth), status: 'pending', requestedAt: Date.now() };
    const updated = await write(room, { pendingRequests: [...(room.pendingRequests || []), pending] });
    notify(req, updated);
    res.status(201).json({ id: requestId, auth, status: 'pending' });
  }));

  router.get('/rooms/:id/requests/:requestId', asHandler(async (req, res) => {
    const room = await roomFor(req);
    const auth = req.get('Authorization')?.match(/^Bearer ([\w-]{43})$/)?.[1];
    if (!isToken(auth)) throw problem(401, 'This join request is invalid.');
    const request = (room.pendingRequests || []).find(item => item._id === req.params.requestId && item.auth === hash(auth));
    if (!request) throw problem(403, 'This join request is no longer available.');
    res.json({ status: request.status, title: room.title, phase: room.phase, serverTime: Date.now() });
  }));

  router.post('/rooms/:id/action', asHandler(async (req, res) => {
    const room = await roomFor(req);
    const { action, value } = req.body;
    const member = protect(req, room, { allowEnded: action === 'leave' });
    const changes = {};
    let updated = room;
    if (action === 'hand') {
      if (room.phase !== 'live') throw problem(409, 'This meeting has ended.');
      const index = room.members.findIndex(person => person._id === member._id);
      changes[`members.${index}.raised`] = !member.raised;
      changes[`members.${index}.raisedAt`] = member.raised ? 0 : Date.now();
    } else {
      protect(req, room, { creator: true });
      if (action === 'admit' || action === 'deny') {
        const requestIndex = (room.pendingRequests || []).findIndex(item => item._id === value && item.status === 'pending');
        const request = room.pendingRequests?.[requestIndex];
        if (!request) throw problem(404, 'That join request is no longer pending.');
        if (action === 'admit') {
          if (room.phase !== 'live' || room.endAt <= Date.now()) throw problem(409, 'This meeting has ended.');
          if (room.members.filter(person => !person.removed).length >= MAX_PEOPLE) throw problem(409, 'This meeting has reached its participant limit.');
          changes.members = [...room.members, {
            _id: id(), name: request.name, auth: request.auth, role: 'participant',
            joinedAt: Date.now(), raised: false, removed: false
          }];
        }
        changes[`pendingRequests.${requestIndex}.status`] = action === 'admit' ? 'admitted' : 'denied';
      } else if (action === 'extend') {
        const minutes = Number(value);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) throw problem(400, 'Choose an extension from 1 to 180 minutes.');
        if (room.phase !== 'live' || room.endAt <= Date.now()) throw problem(409, 'The meeting has already ended.');
        changes.endAt = room.endAt + minutes * 60000;
        changes.duration = room.duration + minutes;
      } else if (action === 'remove') {
        const index = room.members.findIndex(person => person._id === value && person._id !== room.creatorId && !person.removed);
        if (index < 0) throw problem(404, 'That participant cannot be removed.');
        changes[`members.${index}.removed`] = true;
      } else if (action === 'end') {
        if (room.phase !== 'live') throw problem(409, 'This meeting has already ended.');
        changes.phase = 'ended';
      } else {
        throw problem(410, 'That meeting action is no longer available.');
      }
    }
    if (Object.keys(changes).length) updated = await write(room, changes);
    notify(req, updated);
    if (action === 'end') await deleteMediaRoom(room._id);
    if (action === 'remove' && mediaConfig()) {
      const config = mediaConfig();
      try { await config.service.removeParticipant(room._id, value); }
      catch (error) { if (error.code !== 'not_found') throw problem(502, 'The participant could not be disconnected from the call.'); }
    }
    res.json(present(updated, updated.members.find(person => person._id === member._id)));
  }));

  router.post('/rooms/:id/media', asHandler(async (req, res) => {
    const room = await roomFor(req);
    const member = protect(req, room);
    if (room.phase !== 'live' || room.endAt <= Date.now()) throw problem(409, 'This meeting has ended.');
    const config = mediaConfig();
    if (!config) throw problem(503, 'LiveKit is awaiting administrator setup. The meeting lobby and notes remain available.');
    try {
      const active = await config.service.listRooms([room._id]);
      if (!active.length) await config.service.createRoom({ name: room._id, maxParticipants: MAX_PEOPLE, emptyTimeout: 45 });
    } catch (error) {
      if (error.status) throw error;
      throw problem(502, 'The media service could not open this call.');
    }
    const access = new AccessToken(config.key, config.secret, { identity: member._id, name: member.name, ttl: '45s' });
    access.addGrant({
      room: room._id, roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: false,
      canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
    });
    res.json({ url: config.url, token: await access.toJwt() });
  }));

  router.get('/rooms/:id', asHandler(async (req, res) => {
    const room = await roomFor(req);
    const member = protect(req, room, { allowEnded: true });
    res.json(present(room, member));
  }));

  router.get('/rooms/:id/notes', asHandler(async (req, res) => {
    const room = await roomFor(req);
    const member = protect(req, room, { allowEnded: true });
    const docs = await Note.find({ room: room._id, owner: member._id }).sort('createdAt');
    res.json(docs.map(item => ({ key: item.key, tag: item.tag || '', text: decrypt(item.encrypted, item._id) })));
  }));

  router.put('/rooms/:id/notes/:key', asHandler(async (req, res) => {
    const room = await roomFor(req);
    const member = protect(req, room, { allowEnded: true });
    const key = req.params.key;
    if (!['private', 'meeting'].includes(key) && !/^[1-9]\d{0,2}:[1-9]\d{0,2}$/.test(key)) throw problem(400, 'Invalid note reference.');
    const text = typeof req.body.text === 'string' ? req.body.text.slice(0, key === 'meeting' ? 1000000 : 18000) : '';
    const tag = string(req.body.tag, 30);
    const identity = noteId(room._id, member._id, key);
    if (key !== 'meeting' && !text.trim() && !tag) await Note.deleteOne({ _id: identity });
    else await Note.updateOne(
      { _id: identity },
      { $set: { room: room._id, owner: member._id, key, encrypted: encrypt(text, identity), tag } },
      { upsert: true }
    );
    res.json({ saved: true });
  }));

  router.delete('/rooms/:id/notes', asHandler(async (req, res) => {
    const room = await roomFor(req);
    const member = protect(req, room, { allowEnded: true });
    await Note.deleteMany({ room: room._id, owner: member._id });
    res.json({ deleted: true });
  }));

  router.get('/rooms/:id/research', asHandler(async (req, res) => {
    const room = await roomFor(req);
    protect(req, room);
    res.json(await research('web', req.query.q, 'en'));
  }));

  registerStudyRoutes(router, { asHandler, roomFor, protect, write, notify });

  router.all(['/rooms/:id/verse', '/rooms/:id/posts', '/rooms/:id/posts/:post', '/rooms/:id/next-week'], (_req, _res, next) => {
    next(problem(410, 'Quran passage controls and shared posts are no longer available.'));
  });

  router.use((error, _req, res, _next) => {
    if (!error.status) console.error('Tadabbur:', error.message);
    res.status(error.status || 500).json({ message: error.status ? error.message : 'The meeting request could not be completed.' });
  });
  return router;
}
