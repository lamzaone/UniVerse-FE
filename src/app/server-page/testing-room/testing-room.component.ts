import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  ViewChildren,
  QueryList,
  ChangeDetectorRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { UsersService } from '../../services/users.service';
import { AuthService } from '../../services/auth.service';
import { SocketService } from '../../services/socket.service';
import { ServersService } from '../../services/servers.service';
import { ElectronService } from '../../services/electron.service';
import api from '../../services/api.service';
import { Router } from '@angular/router';

interface PeerConnection {
  pc: RTCPeerConnection;
  displayName: string;
  isPolite: boolean;
  tracks: Map<string, { track: MediaStreamTrack; type: 'audio' | 'camera' | 'screen' }>;
  connectionTimeout?: any;
  connectionAttemptCount: number;
  lastConnectionAttempt?: number;
  pendingTrackMetadata: { trackId: string; streamType: 'camera' | 'screen' }[];
}

interface ActiveWindow {
  userId: number;
  windowTitle: string;
  timestamp: number;
}

@Component({
  selector: 'app-testing-room',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './testing-room.component.html',
  styleUrls: ['./testing-room.component.scss']
})
export class TestingRoomComponent implements OnInit, OnDestroy {
  @ViewChild('localVideo', { static: false }) localVideoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('audioContainer', { static: false }) audioContainerRef!: ElementRef<HTMLDivElement>;
  @ViewChildren('remoteVideoContainer') remoteVideoContainers!: QueryList<ElementRef<HTMLDivElement>>;

  roomId: number = 15;
  userId: string = this.authService.getUser().id;
  isAdmin: boolean = this.serverService.currentServer().access_level > 0;

  users: { id: number; name: string; picture: string; isAdmin: boolean }[] = [];
  testUserIds: Set<number> = new Set();
  activeWindows: ActiveWindow[] = [];

  localStream: MediaStream | null = null;
  screenStream: MediaStream | null = null;
  cameraStream: MediaStream | null = null;
  isInTest = false;
  isTestStarted = false;
  isScreenSharing = false;
  isCameraEnabled = false;
  isMicMuted = false;

  sources: { id: string; name: string; thumbnail: string }[] = [];
  peerConnections = new Map<number, PeerConnection>();
  remoteStreams = new Map<number, { camera?: MediaStream; screen?: MediaStream; audio?: MediaStream }>();
  pendingCandidates = new Map<number, RTCIceCandidate[]>();

  private negotiationLock = new Map<number, boolean>();
  private readonly ICE_CONNECTION_TIMEOUT = 3000;
  private readonly MAX_CONNECTION_ATTEMPTS = 3;
  private readonly RECONNECT_BACKOFF_MS = 2000;

  constructor(
    private userService: UsersService,
    private authService: AuthService,
    private socketService: SocketService,
    private serverService: ServersService,
    private electronService: ElectronService,
    private cdr: ChangeDetectorRef,
    private router: Router
  ) {}

  async ngOnInit() {
    if (!this.electronService.isElectron() && !this.isAdmin) {
      alert('You must be an admin to access the testing room in the web version.');
      this.router.navigate(['/server', this.serverService.currentServer().id, 'dashboard']);
    }

    console.log('[Init] Starting testing room');
    await this.fetchUsers();
    this.setupSocketListeners();
    this.socketService.joinAudioRoom(this.roomId.toString());
    this.startWindowTracking();
  }

  ngOnDestroy() {
    console.log('[Destroy] Cleaning up testing room');
    this.leaveTest();
  }

  private async fetchUsers() {
    try {
      const res = await api.get(`http://lamzaone.go.ro:8000/api/room/${this.roomId}/users`);
      this.users = await Promise.all(
        res.data.userIds.map(async (id: string) => {
          const user = await this.userService.getUserInfo(id);
          const accessLevelRes = await api.get(
            `http://lamzaone.go.ro:8000/api/server/${this.serverService.currentServer().id}/user/${id}/access_level`
          );
          return {
            ...user,
            id: parseInt(id),
            isAdmin: accessLevelRes.data.access_level > 0
          };
        })
      );
      this.testUserIds = new Set(this.users.map(u => u.id));
      this.detectChanges();
    } catch (error) {
      console.error('[Init] Failed to fetch users:', error);
    }
  }

  private setupSocketListeners() {
    this.socketService.onAudioRoomMessage((message: string) => {
      if (message.startsWith('user_joined_call')) {
        const userId = parseInt(message.split(':&')[1]);
        if (!isNaN(userId)) this.handleUserJoined(userId);
      } else if (message.startsWith('user_left_call')) {
        const userId = parseInt(message.split(':&')[1]);
        if (!isNaN(userId)) this.handleUserLeft(userId);
      } else if (message.startsWith('test_started')) {
        this.handleTestStarted();
      } else if (message.startsWith('window_update')) {
        const parts = message.split(':&');
        if (parts.length === 3) {
          this.handleWindowUpdate(parseInt(parts[1]), parts[2]);
        }
      } else {
        try {
          const data = JSON.parse(message);
          if (['offer', 'answer', 'ice-candidate', 'track-metadata'].includes(data.type)) {
            this.handleSignalingData(data);
          }
        } catch (error) {
          console.error('[Socket] Error parsing message:', error);
        }
      }
      this.detectChanges();
    });
  }

  private async handleUserJoined(userId: number) {
    // if (userId === parseInt(this.userId) || this.testUserIds.has(userId)) return;

    console.log(`[User] User ${userId} joined`);
    this.testUserIds.add(userId);

    if (!this.users.find(u => u.id === userId)) {
      try {
        const user = await this.userService.getUserInfo(userId.toString());
        const accessLevelRes = await api.get(
          `http://lamzaone.go.ro:8000/api/server/${this.serverService.currentServer().id}/user/${userId}/access_level`
        );
        this.users.push({
          ...user,
          id: userId,
          isAdmin: accessLevelRes.data.access_level > 0
        });
      } catch (error) {
        console.error(`[User] Failed to fetch info for user ${userId}:`, error);
        this.users.push({ id: userId, name: `User ${userId}`, picture: '', isAdmin: false });
      }
    }

    if (this.isInTest) {
      this.initiatePeerConnection(userId);
      this.sendTrackMetadataToUser(userId);
    }
    this.detectChanges();
  }

  private handleUserLeft(userId: number) {
    console.log(`[User] User ${userId} left`);
    this.testUserIds.delete(userId);
    this.closePeerConnection(userId);
    this.users = this.users.filter(u => u.id !== userId);
    this.activeWindows = this.activeWindows.filter(w => w.userId !== userId);
    this.detectChanges();
  }

  private handleTestStarted() {
    console.log('[Test] Test started by admin');
    this.isTestStarted = true;
    if (this.isInTest && !this.isAdmin) {
      this.startScreenShare();
      this.startCamera();
    }
    this.detectChanges();
  }

  private handleWindowUpdate(userId: number, windowTitle: string) {
    console.log(`[Window] User ${userId} active window: ${windowTitle}`);
    const existing = this.activeWindows.find(w => w.userId === userId);
    if (existing) {
      if (existing.windowTitle !== windowTitle) {
        existing.windowTitle = windowTitle;
        existing.timestamp = Date.now();
        console.log(`[Window] Updated timestamp for user ${userId} due to window change`);
      } else {
        console.log(`[Window] No change in window title for user ${userId}`);
      }
    } else {
      this.activeWindows.push({ userId, windowTitle, timestamp: Date.now() });
      console.log(`[Window] Added new window entry for user ${userId}`);
    }
    console.log('[Window] Active windows:', this.activeWindows);
    this.sortUsersByActivity();
    console.log('[Window] Sorted users:', this.users.map(u => ({ id: u.id, name: u.name })));
    this.detectChanges();
  }

  private shouldAttemptReconnect(userId: number): boolean {
    const peer = this.peerConnections.get(userId);
    if (!peer) return true;

    const now = Date.now();
    const attemptCount = peer.connectionAttemptCount || 0;
    const lastAttempt = peer.lastConnectionAttempt || 0;

    if (peer.pc.connectionState === 'connected') {
      return false;
    }

    if (attemptCount >= this.MAX_CONNECTION_ATTEMPTS ||
        (lastAttempt && (now - lastAttempt < this.RECONNECT_BACKOFF_MS))) {
      return false;
    }

    return true;
  }

  private initiatePeerConnection(userId: number) {
    if (!this.testUserIds.has(userId) || userId === parseInt(this.userId)) {
      console.log(`[Connection] Skipping connection for user ${userId}: not in test or self`);
      return;
    }

    if (!this.shouldAttemptReconnect(userId)) {
      console.log(`[Connection] Skipping connection attempt for user ${userId}: max attempts or backoff`);
      return;
    }

    this.createPeerConnection(userId);
  }

  private createPeerConnection(userId: number) {
    const user = this.users.find(u => u.id === userId);
    const displayName = user?.name || `User ${userId}`;
    const isPolite = parseInt(this.userId) < userId;

    const pc = new RTCPeerConnection({
      iceServers: [
        {
          urls: "stun:stun.relay.metered.ca:80",
        },
        {
          urls: "turn:standard.relay.metered.ca:80",
          username: "0e20581fb4b8fc2be07831e3",
          credential: "1KJmXjnD4HKrE2uk",
        },
        {
          urls: "turn:standard.relay.metered.ca:80?transport=tcp",
          username: "0e20581fb4b8fc2be07831e3",
          credential: "1KJmXjnD4HKrE2uk",
        },
        {
          urls: "turn:standard.relay.metered.ca:443",
          username: "0e20581fb4b8fc2be07831e3",
          credential: "1KJmXjnD4HKrE2uk",
        },
        {
          urls: "turns:standard.relay.metered.ca:443?transport=tcp",
          username: "0e20581fb4b8fc2be07831e3",
          credential: "1KJmXjnD4HKrE2uk",
        },
      ],
    });

    const peer: PeerConnection = {
      pc,
      displayName,
      isPolite,
      tracks: new Map(),
      connectionAttemptCount: (this.peerConnections.get(userId)?.connectionAttemptCount || 0) + 1,
      lastConnectionAttempt: Date.now(),
      pendingTrackMetadata: []
    };

    this.peerConnections.set(userId, peer);
    this.pendingCandidates.set(userId, []);
    this.remoteStreams.set(userId, {});

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        this.socketService.sendMessage(
          JSON.stringify({
            type: 'ice-candidate',
            sender: this.userId,
            receiver: userId,
            candidate,
          }),
          false,
          'audioRoom'
        );
      }
    };

    pc.ontrack = ({ track, streams }) => {
      console.log(`[Track] Received track from user ${userId}, track id: ${track.id}, kind: ${track.kind}`);
      if (track.kind === 'audio') {
        this.handleAudioTrack(userId, track, streams[0]);
      } else if (track.kind === 'video' && this.isAdmin) {
        this.handleVideoTrack(userId, peer, track, streams[0]);
      } else if (track.kind === 'video') {
        console.log(`[Track] Ignoring video track from user ${userId} for non-admin user`);
        track.stop();
      }
      const pendingMetadata = peer.pendingTrackMetadata.find(m => m.trackId === track.id);
      if (pendingMetadata) {
        console.log(`[Track] Processing pending metadata for track ${track.id}`);
        this.handleTrackMetadata(userId, pendingMetadata);
        peer.pendingTrackMetadata = peer.pendingTrackMetadata.filter(m => m.trackId !== track.id);
        this.peerConnections.set(userId, peer);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[Connection] State for ${userId}: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        if (this.shouldAttemptReconnect(userId)) {
          setTimeout(() => {
            if (this.testUserIds.has(userId) && this.isInTest) {
              console.log(`[Connection] Attempting reconnect for user ${userId}`);
              this.initiatePeerConnection(userId);
            }
          }, this.RECONNECT_BACKOFF_MS);
        }
      } else if (pc.connectionState === 'connected') {
        clearTimeout(peer.connectionTimeout);
        peer.connectionAttemptCount = 0;
        this.peerConnections.set(userId, peer);
        this.sendTrackMetadataToUser(userId);
      }
    };

    peer.connectionTimeout = setTimeout(() => {
      if (pc.connectionState !== 'connected') {
        console.warn(`[Connection] Timeout for user ${userId}`);
        this.closePeerConnection(userId);
        if (this.shouldAttemptReconnect(userId)) {
          setTimeout(() => {
            if (this.testUserIds.has(userId) && this.isInTest) {
              console.log(`[Connection] Attempting reconnect after timeout for user ${userId}`);
              this.initiatePeerConnection(userId);
            }
          }, this.RECONNECT_BACKOFF_MS);
        }
      }
    }, this.ICE_CONNECTION_TIMEOUT);

    this.addLocalTracksToPeer(peer);

    if (!isPolite) {
      this.negotiateConnection(userId);
    }
  }

  private handleAudioTrack(userId: number, track: MediaStreamTrack, stream: MediaStream) {
    console.log(`[Track] Received audio track from user ${userId}, track id: ${track.id}`);
    const streams = this.remoteStreams.get(userId) || {};
    streams.audio = stream;
    this.remoteStreams.set(userId, streams);

    const existingAudio = this.audioContainerRef.nativeElement.querySelector(`audio[data-user-id="${userId}"]`) as HTMLAudioElement;
    if (existingAudio) {
      existingAudio.srcObject = stream;
    } else {
      const audio = document.createElement('audio');
      audio.srcObject = stream;
      audio.autoplay = true;
      audio.dataset.userId = userId.toString();
      this.audioContainerRef.nativeElement.appendChild(audio);
    }

    track.onended = () => {
      console.log(`[Track] Audio track ${track.id} ended for user ${userId}`);
      streams.audio?.getTracks().forEach(t => t.stop());
      delete streams.audio;
      this.remoteStreams.set(userId, streams);
      this.audioContainerRef.nativeElement
        .querySelectorAll(`audio[data-user-id="${userId}"]`)
        .forEach(audio => audio.remove());
      this.detectChanges();
    };
  }

  private handleVideoTrack(userId: number, peer: PeerConnection, track: MediaStreamTrack, stream: MediaStream) {
    console.log(`[Track] Received video track from user ${userId}, track id: ${track.id}`);
    if (track.readyState !== 'live') {
      console.log(`[Track] Ignoring non-live track ${track.id}`);
      return;
    }

    // Prevent track from being assigned to multiple users
    this.peerConnections.forEach((otherPeer, otherUserId) => {
      if (otherUserId !== userId && otherPeer.tracks.has(track.id)) {
        console.warn(`[Track] Track ${track.id} already assigned to user ${otherUserId}, skipping for ${userId}`);
        return;
      }
    });

    type StreamType = 'camera' | 'screen' | 'audio';
    let trackType: StreamType = 'camera';
    const pendingMetadata = peer.pendingTrackMetadata.find(m => m.trackId === track.id);
    if (pendingMetadata) {
      trackType = pendingMetadata.streamType;
    } else if (peer.tracks.has(track.id)) {
      trackType = peer.tracks.get(track.id)!.type;
    }

    const streams = this.remoteStreams.get(userId) || {};
    let targetStream: MediaStream | undefined = undefined;
    if (trackType === 'camera' || trackType === 'screen' || trackType === 'audio') {
      targetStream = streams[trackType];
      if (!targetStream) {
        targetStream = new MediaStream();
        streams[trackType] = targetStream;
      }
    }

    if (
      targetStream &&
      !targetStream.getTracks().some((t: MediaStreamTrack) => t.id === track.id)
    ) {
      targetStream.addTrack(track);
      peer.tracks.set(track.id, { track, type: trackType });
      this.remoteStreams.set(userId, streams);
      this.updateVideoElements(userId);
    } else {
      console.warn(`[Track] Track ${track.id} already added to stream for user ${userId}`);
    }

    track.onended = () => {
      console.log(`[Track] Video track ${track.id} ended for user ${userId}`);
      if (targetStream) {
        targetStream.removeTrack(track);
      }
      peer.tracks.delete(track.id);
      if (targetStream && !targetStream.getTracks().length) {
        if (trackType === 'camera' || trackType === 'screen' || trackType === 'audio') {
          delete streams[trackType];
          this.remoteStreams.set(userId, streams);
        }
      }
      this.updateVideoElements(userId);
    };
  }

  private addLocalTracksToPeer(peer: PeerConnection) {
    const userId = Array.from(this.peerConnections.keys()).find(id => this.peerConnections.get(id) === peer);
    if (!userId) return;

    const recipient = this.users.find(u => u.id === userId);
    const isRecipientAdmin = recipient?.isAdmin || false;

    const tracks: { track: MediaStreamTrack; type: 'audio' | 'camera' | 'screen' }[] = [];
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => tracks.push({ track, type: 'audio' }));
    }
    if (isRecipientAdmin && this.cameraStream) {
      this.cameraStream.getVideoTracks().forEach(track => tracks.push({ track, type: 'camera' }));
    }
    if (isRecipientAdmin && this.screenStream) {
      this.screenStream.getVideoTracks().forEach(track => tracks.push({ track, type: 'screen' }));
    }

    const senders = peer.pc.getSenders();
    senders.forEach(sender => {
      if (sender.track && !tracks.some(t => t.track === sender.track)) {
        console.log(`[Track] Removing stopped track ${sender.track.id} from peer ${peer.displayName}`);
        peer.pc.removeTrack(sender);
        peer.tracks.delete(sender.track.id);
      }
    });

    tracks.forEach(({ track, type }) => {
      if (!peer.pc.getSenders().some(s => s.track === track)) {
        console.log(`[Track] Adding ${type} track ${track.id} to peer ${peer.displayName}`);
        peer.pc.addTrack(track, new MediaStream([track]));
        peer.tracks.set(track.id, { track, type });
        this.socketService.sendMessage(
          JSON.stringify({
            type: 'track-metadata',
            sender: this.userId,
            receiver: userId,
            trackId: track.id,
            streamType: type,
          }),
          false,
          'audioRoom'
        );
      }
    });
  }

  private sendTrackMetadataToUser(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (!peer) return;

    const tracks: { track: MediaStreamTrack; type: 'audio' | 'camera' | 'screen' }[] = [];
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => tracks.push({ track, type: 'audio' }));
    }
    if (this.cameraStream) {
      this.cameraStream.getVideoTracks().forEach(track => tracks.push({ track, type: 'camera' }));
    }
    if (this.screenStream) {
      this.screenStream.getVideoTracks().forEach(track => tracks.push({ track, type: 'screen' }));
    }

    tracks.forEach(({ track, type }) => {
      if (peer.tracks.has(track.id)) {
        this.socketService.sendMessage(
          JSON.stringify({
            type: 'track-metadata',
            sender: this.userId,
            receiver: userId,
            trackId: track.id,
            streamType: type,
          }),
          false,
          'audioRoom'
        );
      }
    });
  }

  private updateVideoElements(userId: number) {
    const userContainer = this.remoteVideoContainers.find(
      c => (c.nativeElement.closest('.user') as HTMLElement)?.dataset.userId === userId.toString()
    )?.nativeElement;

    if (!userContainer) {
      console.warn(`[Video] No container for user ${userId}`);
      return;
    }

    const streams = this.remoteStreams.get(userId) || {};

    if (streams.screen) {
      const liveTracks = streams.screen.getVideoTracks().filter(t => t.readyState === 'live');
      liveTracks.forEach(track => {
        const video = userContainer.querySelector(`video.screen-share[data-track-id="${track.id}"]`) as HTMLVideoElement;
        if (!video) {
          console.log(`[Video] Adding screen stream for user ${userId}, track ${track.id}`);
          const newVideo = document.createElement('video');
          newVideo.classList.add('screen-share');
          newVideo.dataset.userId = userId.toString();
          newVideo.dataset.streamType = 'screen';
          newVideo.dataset.trackId = track.id;
          newVideo.autoplay = true;
          newVideo.playsInline = true;
          newVideo.srcObject = new MediaStream([track]);
          this.safePlayVideo(newVideo);
          userContainer.appendChild(newVideo);
        }
      });
      userContainer.querySelectorAll('video.screen-share').forEach(video => {
        const trackId = (video as HTMLVideoElement).dataset.trackId;
        if (!trackId || !liveTracks.some(t => t.id === trackId)) {
          console.log(`[Video] Removing screen stream for user ${userId}, track ${trackId}`);
          video.remove();
        }
      });
      if (!liveTracks.length) {
        delete streams.screen;
        this.remoteStreams.set(userId, streams);
      }
    }

    if (streams.camera) {
      const liveTracks = streams.camera.getVideoTracks().filter(t => t.readyState === 'live');
      liveTracks.forEach(track => {
        const video = userContainer.querySelector(`video.camera-video[data-track-id="${track.id}"]`) as HTMLVideoElement;
        if (!video) {
          console.log(`[Video] Adding camera stream for user ${userId}, track ${track.id}`);
          const newVideo = document.createElement('video');
          newVideo.classList.add('camera-video');
          newVideo.dataset.userId = userId.toString();
          newVideo.dataset.streamType = 'camera';
          newVideo.dataset.trackId = track.id;
          newVideo.autoplay = true;
          newVideo.playsInline = true;
          newVideo.srcObject = new MediaStream([track]);
          this.safePlayVideo(newVideo);
          userContainer.insertBefore(newVideo, userContainer.querySelector('video.screen-share')?.nextSibling || null);
        }
      });
      userContainer.querySelectorAll('video.camera-video').forEach(video => {
        const trackId = (video as HTMLVideoElement).dataset.trackId;
        if (!trackId || !liveTracks.some(t => t.id === trackId)) {
          console.log(`[Video] Removing camera stream for user ${userId}, track ${trackId}`);
          video.remove();
        }
      });
      if (!liveTracks.length) {
        delete streams.camera;
        this.remoteStreams.set(userId, streams);
      }
    }

    this.detectChanges();
  }

  async joinTestRoom() {
    if (this.isInTest) return;

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: this.isCameraEnabled ? { width: { max: 320 }, height: { max: 240 }, frameRate: { max: 30 } } : false,
      });

      this.isInTest = true;
      this.socketService.sendMessage(`user_joined_call:&${this.userId}`, false, 'audioRoom');
      this.testUserIds.add(parseInt(this.userId));

      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = this.localStream;
        this.localVideoRef.nativeElement.muted = true;
        this.safePlayVideo(this.localVideoRef.nativeElement);
      }

      this.users.forEach(user => {
        if (user.id !== parseInt(this.userId) && this.testUserIds.has(user.id)) {
          this.initiatePeerConnection(user.id);
          this.sendTrackMetadataToUser(user.id);
        }
      });

      if (this.isTestStarted && !this.isAdmin) {
        await this.startScreenShare();
        await this.startCamera();
      }

      this.detectChanges();
    } catch (error) {
      console.error('[Test] Failed to join:', error);
      this.isInTest = false;
    }
  }

  startTest() {
    if (!this.isAdmin || this.isTestStarted) return;
    console.log('[Test] Admin starting test');
    this.isTestStarted = true;
    this.socketService.sendMessage('test_started', false, 'audioRoom');
    this.detectChanges();
  }

  async startScreenShare(sourceId?: string) {
    if (this.isScreenSharing || this.isAdmin) return;

    try {
      let constraints: MediaStreamConstraints;

      if (this.electronService.isElectron() && !sourceId) {
        const selectedSource = await this.electronService.showScreenPicker();
        if (!selectedSource) {
          console.log('User cancelled screen selection');
          return;
        }
        sourceId = selectedSource.id;
        console.log('Selected source:', selectedSource.name);
      }

      if (this.electronService.isElectron() && sourceId) {
        constraints = {
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              minWidth: 1280,
              maxWidth: 1920,
              minHeight: 720,
              maxHeight: 1080,
              minFrameRate: 15,
              maxFrameRate: 30
            }
          } as any
        };
      } else {
        constraints = {
          video: {
            width: { max: 1920 },
            height: { max: 1080 },
            frameRate: { max: 30 },
          },
          audio: false
        };
      }

      this.screenStream = this.electronService.isElectron() && sourceId
        ? await navigator.mediaDevices.getUserMedia(constraints)
        : await navigator.mediaDevices.getDisplayMedia(constraints);

      this.isScreenSharing = true;

      this.screenStream.getTracks().forEach(track => {
        track.contentHint = 'detail';
        track.onended = () => {
          console.log(`[Track] Screen track ${track.id} ended`);
          this.stopScreenShare();
        };
      });

      const videoElement = document.querySelector('video');
      if (videoElement) {
        videoElement.srcObject = this.screenStream;
      }
      console.log('Screen sharing started:', this.screenStream);

      this.updateLocalStream();
      this.peerConnections.forEach((peer, userId) => {
        const recipient = this.users.find(u => u.id === userId);
        if (recipient?.isAdmin) {
          this.addLocalTracksToPeer(peer);
          if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
            this.negotiateConnection(userId);
          }
        }
      });
      this.detectChanges();
    } catch (error: any) {
      console.error('[ScreenShare] Failed:', error);
      this.isScreenSharing = false;
      this.screenStream = null;
      this.sources = [];
      if (error instanceof DOMException) {
        console.error(`DOMException: ${error.name} - ${error.message}`);
        if (error.name === 'NotAllowedError') {
          console.error('User denied screen sharing permission');
        } else if (error.name === 'NotSupportedError') {
          console.error('Screen sharing not supported. Ensure browser/Electron supports getDisplayMedia.');
        }
      }
    }
  }

  async startCamera() {
    if (this.isCameraEnabled || this.isAdmin) return;

    try {
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { max: 320 }, height: { max: 240 }, frameRate: { max: 30 } },
      });
      this.isCameraEnabled = true;

      this.cameraStream.getTracks().forEach(track => {
        track.onended = () => {
          console.log(`[Track] Camera track ${track.id} ended`);
          this.stopCamera();
        };
      });

      this.updateLocalStream();
      this.peerConnections.forEach((peer, userId) => {
        const recipient = this.users.find(u => u.id === userId);
        if (recipient?.isAdmin) {
          this.addLocalTracksToPeer(peer);
          if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
            this.negotiateConnection(userId);
          }
        }
      });
      this.detectChanges();
    } catch (error) {
      console.error('[Camera] Failed to start:', error);
      this.isCameraEnabled = false;
      this.cameraStream = null;
    }
  }

  private stopScreenShare() {
    if (!this.isScreenSharing) return;

    this.screenStream?.getTracks().forEach(track => {
      console.log(`[Track] Stopping screen track ${track.id}`);
      track.stop();
    });
    this.screenStream = null;
    this.isScreenSharing = false;

    this.updateLocalStream();
    this.peerConnections.forEach((peer, userId) => {
      const recipient = this.users.find(u => u.id === userId);
      if (recipient?.isAdmin) {
        this.addLocalTracksToPeer(peer);
        if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
          this.negotiateConnection(userId);
        }
      }
    });
    this.detectChanges();
  }

  private stopCamera() {
    if (!this.isCameraEnabled) return;

    this.cameraStream?.getTracks().forEach(track => {
      console.log(`[Track] Stopping camera track ${track.id}`);
      track.stop();
    });
    this.cameraStream = null;
    this.isCameraEnabled = false;

    this.updateLocalStream();
    this.peerConnections.forEach((peer, userId) => {
      const recipient = this.users.find(u => u.id === userId);
      if (recipient?.isAdmin) {
        this.addLocalTracksToPeer(peer);
        if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
          this.negotiateConnection(userId);
        }
      }
    });
    this.detectChanges();
  }

  private updateLocalStream() {
    const tracks: MediaStreamTrack[] = [];
    if (this.localStream) {
      tracks.push(...this.localStream.getAudioTracks());
    }
    if (this.cameraStream) {
      tracks.push(...this.cameraStream.getVideoTracks());
    }
    if (this.screenStream) {
      tracks.push(...this.screenStream.getVideoTracks());
    }

    this.localStream = tracks.length ? new MediaStream(tracks) : null;
    if (this.localVideoRef?.nativeElement) {
      this.localVideoRef.nativeElement.srcObject = this.localStream;
      this.safePlayVideo(this.localVideoRef.nativeElement);
    }
  }

  private async negotiateConnection(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (!peer || peer.pc.signalingState !== 'stable' || this.negotiationLock.get(userId)) return;

    const recipient = this.users.find(u => u.id === userId);
    if (!recipient) return;

    this.negotiationLock.set(userId, true);
    try {
      const offer = await peer.pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: this.isAdmin && recipient.isAdmin,
      });
      await peer.pc.setLocalDescription(offer);
      this.socketService.sendMessage(
        JSON.stringify({
          type: 'offer',
          sender: this.userId,
          receiver: userId,
          sdp: offer.sdp,
        }),
        false,
        'audioRoom'
      );
    } catch (error) {
      console.error(`[Negotiation] Error for user ${userId}:`, error);
      this.closePeerConnection(userId);
      if (this.shouldAttemptReconnect(userId)) {
        setTimeout(() => {
          if (this.testUserIds.has(userId) && this.isInTest) {
            console.log(`[Connection] Attempting reconnect after negotiation error for user ${userId}`);
            this.initiatePeerConnection(userId);
          }
        }, this.RECONNECT_BACKOFF_MS);
      }
    } finally {
      this.negotiationLock.set(userId, false);
    }
  }

  private async handleSignalingData(data: any) {
    const senderId = parseInt(data.sender);
    const receiverId = parseInt(data.receiver);

    if (isNaN(senderId) || receiverId !== parseInt(this.userId) || !this.testUserIds.has(senderId)) {
      console.warn(`[Signaling] Invalid signaling data: sender=${senderId}, receiver=${receiverId}`);
      return;
    }

    switch (data.type) {
      case 'offer':
        await this.handleOffer(senderId, data);
        break;
      case 'answer':
        await this.handleAnswer(senderId, data);
        break;
      case 'ice-candidate':
        await this.handleCandidate(senderId, data.candidate);
        break;
      case 'track-metadata':
        this.handleTrackMetadata(senderId, data);
        break;
    }
  }

  private async handleOffer(userId: number, data: any) {
    let peer = this.peerConnections.get(userId);
    if (!peer) {
      this.initiatePeerConnection(userId);
      peer = this.peerConnections.get(userId)!;
    }

    if (this.negotiationLock.get(userId)) return;

    this.negotiationLock.set(userId, true);
    try {
      if (peer.pc.signalingState !== 'stable') {
        if (peer.isPolite) return;
        await peer.pc.setLocalDescription({ type: 'rollback' });
      }

      await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.socketService.sendMessage(
        JSON.stringify({
          type: 'answer',
          sender: this.userId,
          receiver: userId,
          sdp: answer.sdp,
        }),
        false,
        'audioRoom'
      );
    } catch (error) {
      console.error(`[Offer] Error for user ${userId}:`, error);
      this.closePeerConnection(userId);
      if (this.shouldAttemptReconnect(userId)) {
        setTimeout(() => {
          if (this.testUserIds.has(userId) && this.isInTest) {
            console.log(`[Connection] Attempting reconnect after offer error for user ${userId}`);
            this.initiatePeerConnection(userId);
          }
        }, this.RECONNECT_BACKOFF_MS);
      }
    } finally {
      this.negotiationLock.set(userId, false);
    }
  }

  private async handleAnswer(userId: number, data: any) {
    const peer = this.peerConnections.get(userId);
    if (!peer || peer.pc.signalingState !== 'have-local-offer') return;

    try {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
    } catch (error) {
      console.error(`[Answer] Error for user ${userId}:`, error);
      this.closePeerConnection(userId);
      if (this.shouldAttemptReconnect(userId)) {
        setTimeout(() => {
          if (this.testUserIds.has(userId) && this.isInTest) {
            console.log(`[Connection] Attempting reconnect after answer error for user ${userId}`);
            this.initiatePeerConnection(userId);
          }
        }, this.RECONNECT_BACKOFF_MS);
      }
    }
  }

  private async handleCandidate(userId: number, candidate: any) {
    const peer = this.peerConnections.get(userId);
    if (!peer) return;

    try {
      const rtcCandidate = new RTCIceCandidate(candidate);
      if (peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(rtcCandidate);
      } else {
        const candidates = this.pendingCandidates.get(userId) || [];
        candidates.push(rtcCandidate);
        this.pendingCandidates.set(userId, candidates);
      }
    } catch (error) {
      console.error(`[ICE] Error adding candidate for user ${userId}:`, error);
    }
  }

  private handleTrackMetadata(userId: number, data: { trackId: string; streamType: 'camera' | 'screen' }) {
    const peer = this.peerConnections.get(userId);
    if (!peer || !data.trackId || !['camera', 'screen'].includes(data.streamType)) {
      console.warn(`[TrackMetadata] Invalid metadata for user ${userId}:`, data);
      return;
    }

    console.log(`[TrackMetadata] User ${userId}: track ${data.trackId} is ${data.streamType}`);
    const trackInfo = peer.tracks.get(data.trackId);

    if (!trackInfo) {
      if (!peer.pendingTrackMetadata.some(m => m.trackId === data.trackId)) {
        peer.pendingTrackMetadata.push({ trackId: data.trackId, streamType: data.streamType });
        this.peerConnections.set(userId, peer);
      }
      return;
    }

    if (trackInfo.type === data.streamType) return;

    const oldType = trackInfo.type;
    trackInfo.type = data.streamType;

    const streams = this.remoteStreams.get(userId) || {};
    const oldStream = streams[oldType];
    const newStream = streams[data.streamType] || new MediaStream();
    streams[data.streamType] = newStream;

    if (oldStream) {
      oldStream.removeTrack(trackInfo.track);
      if (!oldStream.getTracks().length) {
        delete streams[oldType];
      }
    }

    if (trackInfo.track.readyState === 'live') {
      if (!newStream.getTracks().some(t => t.id === trackInfo.track.id)) {
        newStream.addTrack(trackInfo.track);
      }
    } else {
      console.log(`[TrackMetadata] Track ${data.trackId} is not live, removing`);
      peer.tracks.delete(data.trackId);
      if (!newStream.getTracks().length) {
        delete streams[data.streamType];
      }
    }

    this.remoteStreams.set(userId, streams);
    this.updateVideoElements(userId);
  }

  private closePeerConnection(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (!peer) return;

    peer.pc.close();
    clearTimeout(peer.connectionTimeout);

    const streams = this.remoteStreams.get(userId);
    if (streams) {
      (['audio', 'camera', 'screen'] as const).forEach(type => {
        const stream = streams[type];
        if (stream) {
          stream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
          delete streams[type];
        }
      });
      this.remoteStreams.delete(userId);
    }

    this.audioContainerRef.nativeElement
      .querySelectorAll(`audio[data-user-id="${userId}"]`)
      .forEach(audio => audio.remove());

    const userContainer = this.remoteVideoContainers.find(
      c => (c.nativeElement.closest('.user') as HTMLElement)?.dataset.userId === userId.toString()
    )?.nativeElement;

    if (userContainer) {
      userContainer.querySelectorAll(`video[data-user-id="${userId}"]`).forEach(video => video.remove());
    }

    this.peerConnections.delete(userId);
    this.pendingCandidates.delete(userId);
    this.detectChanges();
  }

  leaveTest() {
    this.peerConnections.forEach((_, userId) => this.closePeerConnection(userId));
    this.localStream?.getTracks().forEach(track => track.stop());
    this.screenStream?.getTracks().forEach(track => track.stop());
    this.cameraStream?.getTracks().forEach(track => track.stop());

    this.localStream = null;
    this.screenStream = null;
    this.cameraStream = null;
    this.isInTest = false;
    this.isTestStarted = false;
    this.isScreenSharing = false;
    this.isCameraEnabled = false;
    this.isMicMuted = false;

    if (this.localVideoRef?.nativeElement) {
      this.localVideoRef.nativeElement.srcObject = null;
    }

    this.audioContainerRef.nativeElement.innerHTML = '';
    this.remoteStreams.clear();
    this.detectChanges();
    this.socketService.sendMessage(`user_left_call:&${this.userId}`, false, 'audioRoom');
  }

  toggleMic() {
    this.isMicMuted = !this.isMicMuted;
    this.localStream?.getAudioTracks().forEach(track => {
      track.enabled = !this.isMicMuted;
    });
    this.detectChanges();
  }

  private startWindowTracking() {
    setInterval(async () => {
      if (!this.isInTest || !this.electronService.isElectron()) return;
      const activeWindow = await this.electronService.getActiveWindow();
      if (activeWindow) {
        this.socketService.sendMessage(
          `window_update:&${this.userId}:&${activeWindow.title}`,
          false,
          'audioRoom'
        );
      }
    }, 5000);
  }

  private sortUsersByActivity() {
    this.users.sort((a, b) => {
      const aWindow = this.activeWindows.find(w => w.userId === a.id);
      const bWindow = this.activeWindows.find(w => w.userId === b.id);
      const aSharing = this.remoteStreams.get(a.id)?.screen ? 1 : 0;
      const bSharing = this.remoteStreams.get(b.id)?.screen ? 1 : 0;

      if (!aWindow && !bWindow) return aSharing - bSharing;
      if (!aWindow) return 1;
      if (!bWindow) return -1;
      if (aWindow.timestamp !== bWindow.timestamp) {
        return bWindow.timestamp - aWindow.timestamp;
      }
      return aSharing - bSharing;
    });
  }

  private safePlayVideo(element: HTMLVideoElement) {
    if (element.srcObject) {
      element.play().catch(err => {
        if (err.name === 'NotAllowedError') {
          document.addEventListener(
            'click',
            () => element.play().catch(e => console.error('[Video] Play error:', e)),
            { once: true }
          );
        }
      });
    }
  }

  private detectChanges() {
    this.cdr.detectChanges();
  }
}
