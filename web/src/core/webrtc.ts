// WebRTC links for the local mode: a data channel between two devices, with no STUN or TURN
// server, so only "host" candidates are gathered: it connects on the same network only,
// and never through a third party. Its setup messages (SDP, candidates) go through the
// relay, encrypted by the engine.
import type { Link, LinkFactory, Pending } from './peers.ts';

type RTC = typeof RTCPeerConnection;

export const webrtcAvailable = () => typeof (globalThis as any).RTCPeerConnection === 'function';

export function webrtcLinks(RTCImpl: RTC = (globalThis as any).RTCPeerConnection): LinkFactory {
  return {
    connect: (signal) => setup(RTCImpl, signal, true),
    accept: (signal) => setup(RTCImpl, signal, false),
  };
}

function setup(RTCImpl: RTC, signal: (msg: any) => void, initiator: boolean): Pending {
  const pc = new RTCImpl({ iceServers: [] });
  let settled = false;
  let remoteSet = false;
  const early: RTCIceCandidateInit[] = [];
  let resolveLink!: (l: Link) => void;
  let rejectLink!: (e: Error) => void;
  const link = new Promise<Link>((res, rej) => {
    resolveLink = res;
    rejectLink = rej;
  });
  link.catch(() => {});

  const fail = (why: string) => {
    if (settled) return;
    settled = true;
    try {
      pc.close();
    } catch {}
    rejectLink(new Error(why));
  };

  const ready = (dc: RTCDataChannel) => {
    dc.binaryType = 'arraybuffer';
    const open = () => {
      if (settled) return;
      settled = true;
      resolveLink(wrap(pc, dc));
    };
    if (dc.readyState === 'open') open();
    else dc.onopen = open;
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) signal({ t: 'ice', c: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') fail(pc.connectionState);
  };

  if (initiator) {
    ready(pc.createDataChannel('entrenous', { ordered: true }));
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => signal({ t: 'offer', sdp: pc.localDescription!.sdp }))
      .catch(() => fail('offer'));
  } else {
    pc.ondatachannel = (e) => ready(e.channel);
  }

  const addCandidate = (c: RTCIceCandidateInit) => pc.addIceCandidate(c).catch(() => {});

  return {
    link,
    cancel: () => fail('cancelled'),
    receive(msg) {
      if (settled && msg.t !== 'ice') return;
      if (msg.t === 'offer' && !initiator) {
        pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
          .then(() => {
            remoteSet = true;
            early.splice(0).forEach(addCandidate);
            return pc.createAnswer();
          })
          .then((answer) => pc.setLocalDescription(answer))
          .then(() => signal({ t: 'answer', sdp: pc.localDescription!.sdp }))
          .catch(() => fail('answer'));
      } else if (msg.t === 'answer' && initiator) {
        pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
          .then(() => {
            remoteSet = true;
            early.splice(0).forEach(addCandidate);
          })
          .catch(() => fail('answer'));
      } else if (msg.t === 'ice' && msg.c) {
        if (remoteSet) addCandidate(msg.c);
        else early.push(msg.c);
      }
    },
  };
}

function wrap(pc: RTCPeerConnection, dc: RTCDataChannel): Link {
  let closed = false;
  const closing = () => {
    if (closed) return;
    closed = true;
    link.onClose();
  };
  const link: Link = {
    send: (data) => dc.send(data as any),
    get bufferedAmount() {
      return dc.bufferedAmount;
    },
    // the other side's limit (64 KB is safe everywhere when it is not known)
    maxMessage: pc.sctp?.maxMessageSize || 64 * 1024,
    drained(bytes) {
      if (dc.bufferedAmount <= bytes || closed) return Promise.resolve();
      dc.bufferedAmountLowThreshold = bytes;
      return new Promise((resolve) => {
        const done = () => {
          dc.removeEventListener('bufferedamountlow', done);
          dc.removeEventListener('close', done);
          resolve();
        };
        dc.addEventListener('bufferedamountlow', done);
        dc.addEventListener('close', done);
      });
    },
    onMessage: () => {},
    onClose: () => {},
    close() {
      try {
        dc.close();
        pc.close();
      } catch {}
      closing();
    },
  };
  dc.onmessage = (e) => link.onMessage(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
  dc.onclose = closing;
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      closing();
    }
  });
  return link;
}
