import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  ViewChildren,
  QueryList
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { UsersService } from '../../services/users.service';
import { AuthService } from '../../services/auth.service';
import { SocketService } from '../../services/socket.service';
import { ServersService } from '../../services/servers.service';
import { ElectronService } from '../../services/electron.service';
import api from '../../services/api.service';

interface PeerConnection {
  pc: RTCPeerConnection;
  streams: {
    screen?: MediaStreamTrack;
  };
  displayName: string;
  retryCount: number;
  lastConnectionAttempt: number;
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

  users: any[] = [];
  testUserIds: Set<number> = new Set();
  activeWindows: ActiveWindow[] = [];

  localStream?: MediaStream;
  peerConnections = new Map<number, PeerConnection>();
  remoteStreams = new Map<number, { screen?: MediaStream }>();
  pendingCandidates = new Map<number, RTCIceCandidate[]>();

  isInTest = false;
  isTestStarted = false;
  isScreenSharing = false;

  private changeDetectionTimeout: any;
  private negotiationLock = new Map<number, boolean>();
  private windowCheckInterval: any;
  private readonly MAX_RETRIES = 5;
  private readonly BASE_RETRY_DELAY = 1000; // 1 second
  private readonly ICE_CONNECTION_TIMEOUT = 10000; // 10 seconds

  constructor(
    private userService: UsersService,
    private authService: AuthService,
    private socketService: SocketService,
    private serverService: ServersService,
    private electronService: ElectronService,
    private cdr: ChangeDetectorRef
  ) {}

  async ngOnInit() {
    console.log('[Init] Initializing testing room component');
    await this.fetchInitialUsers();
    this.setupSocketListeners();
    this.socketService.joinAudioRoom(this.roomId.toString());
    this.startWindowTracking();
  }

  ngOnDestroy() {
    console.log('[Destroy] Cleaning up testing room component');
    this.leaveTest();
    if (this.changeDetectionTimeout) clearTimeout(this.changeDetectionTimeout);
    if (this.windowCheckInterval) clearInterval(this.windowCheckInterval);
  }

  private async fetchInitialUsers() {
    try {
      const res = await api.get(`http://lamzaone.go.ro:8000/api/room/${this.roomId}/users`);
      this.users = await Promise.all(
        res.data.userIds.map(async (id: string) => {
          const user = await this.userService.getUserInfo(id);
          const user_access_level_res = await api.get(
            `http://lamzaone.go.ro:8000/api/server/${this.serverService.currentServer().id}/user/${id}/access_level`
          );
          console.log(`[Init] Fetched user ${id}:`, user, ' access level:', user_access_level_res.data.access_level);
          return { ...user, id: parseInt(id), isAdmin: user_access_level_res.data.access_level > 0 };
        })
      );
      console.log('[Init] Users fetched:', this.users);
      this.testUserIds = new Set(this.users.map(u => u.id));
      this.debounceChangeDetection();
    } catch (error) {
      console.error('[Init] Failed to fetch users', error);
    }
  }

  joinTestRoom() {
    if (this.isInTest) return;
    console.log('[Test] Joining test room');
    this.isInTest = true;
    this.socketService.sendMessage(`user_joined_call:&${this.userId}`, false, 'audioRoom');
    this.testUserIds.add(parseInt(this.userId));

    if (this.isTestStarted && !this.isAdmin) {
      this.startScreenShare();
    } else if (this.isAdmin) {
      // Admins wait for users to initiate connections
    } else {
      // Non-admins create connections to all admins
      this.users.forEach(user => {
        if (user.isAdmin && user.id !== parseInt(this.userId)) {
          this.createPeerConnection(user.id);
        }
      });
    }
    this.debounceChangeDetection();
  }

  private setupSocketListeners() {
    console.log('[Socket] Setting up socket listeners');
    this.socketService.onAudioRoomMessage((message: string) => {
      console.log('[Socket] Received message:', message);
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
          this.handleSignalingData(data);
        } catch {
          console.log('[Socket] Non-JSON message:', message);
        }
      }
      this.debounceChangeDetection();
    });
  }

  private async handleUserJoined(userId: number) {
    if (!this.testUserIds.has(userId) && userId !== parseInt(this.userId)) {
      console.log(`[User] User ${userId} joined test`);
      this.testUserIds.add(userId);
      try {
        const user = await this.userService.getUserInfo(userId.toString());
        const user_access_level_res = await api.get(
          `http://lamzaone.go.ro:8000/api/server/${this.serverService.currentServer().id}/user/${userId}/access_level`
        );
        const userData = {
          ...user,
          id: userId,
          isAdmin: user_access_level_res.data.access_level > 0
        };
        if (!this.users.find(u => u.id === userId)) {
          this.users.push(userData);
        }
      } catch (error) {
        console.error(`[User] Failed to fetch info for user ${userId}`, error);
        if (!this.users.find(u => u.id === userId)) {
          this.users.push({ id: userId, name: `User ${userId}`, picture: '', isAdmin: false });
        }
      }
      this.debounceChangeDetection();
    }
  }

  private handleUserLeft(userId: number) {
    console.log(`[User] User ${userId} left test`);
    this.testUserIds.delete(userId);
    this.closePeerConnection(userId);
    this.users = this.users.filter(u => u.id !== userId);
    this.activeWindows = this.activeWindows.filter(w => w.userId !== userId);
    this.debounceChangeDetection();
  }

  private handleTestStarted() {
    console.log('[Test] Test started by admin');
    this.isTestStarted = true;
    if (this.isInTest && !this.isAdmin) {
      this.startScreenShare();
      // Create connections to all admins
      this.users.forEach(user => {
        if (user.isAdmin && user.id !== parseInt(this.userId)) {
          this.createPeerConnection(user.id);
        }
      });
    }
    this.debounceChangeDetection();
  }

  private handleWindowUpdate(userId: number, windowTitle: string) {
    console.log(`[Window] User ${userId} active window: ${windowTitle}`);
    const existing = this.activeWindows.find(w => w.userId === userId);
    if (existing) {
      existing.windowTitle = windowTitle;
      existing.timestamp = Date.now();
    } else {
      this.activeWindows.push({ userId, windowTitle, timestamp: Date.now() });
    }
    this.sortUsersByActivity();
    this.debounceChangeDetection();
  }

  private createPeerConnection(userId: number): void {
    const user = this.users.find(u => u.id === userId);
    // Allow connections where one user is admin and the other is not
    if (!user || (this.isAdmin && user.isAdmin) || (!this.isAdmin && !user.isAdmin)) {
      console.log(`[Peer] Skipping connection to ${userId}: invalid role combination`);
      return;
    }

    if (this.peerConnections.has(userId)) {
      this.closePeerConnection(userId);
    }
    const displayName = user?.name || `User ${userId}`;
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.relay.metered.ca:80" },
        {
          urls: "turn:standard.relay.metered.ca:80",
          username: "0e20581fb4b8fc2be07831e3",
          credential: "1KJmXjnD4HKrE2uk",
        },
        {
          urls: "turn:standard.relay.metered.ca:443",
          username: "0e20581fb4b8fc2be07831e3",
          credential: "1KJmXjnD4HKrE2uk",
        },
        { urls: "stun:stun.l.google.com:19302" }, // Additional STUN server
        { urls: "stun:stun1.l.google.com:19302" }  // Additional STUN server
      ]
    });
    const peer: PeerConnection = {
      pc,
      streams: {},
      displayName,
      retryCount: 0,
      lastConnectionAttempt: 0
    };
    this.peerConnections.set(userId, peer);
    this.pendingCandidates.set(userId, []);

    // ICE connection timeout monitoring
    const connectionTimeout = setTimeout(() => {
      if (pc.connectionState !== 'connected' && pc.connectionState !== 'connecting') {
        console.warn(`[Connection] Timeout for user ${userId}`);
        this.reconnectPeer(userId);
      }
    }, this.ICE_CONNECTION_TIMEOUT);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`[ICE] Sending candidate to user ${userId}`);
        this.sendIceCandidateWithRetry(userId, event.candidate);
      }
    };

    pc.ontrack = (event) => {
      console.log(`[Track] Received track from user ${userId}:`, event.track.kind);
      const stream = event.streams[0];
      if (event.track.kind === 'video') {
        this.remoteStreams.set(userId, { screen: stream });
        this.updateVideoElements(userId);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[Connection] State for user ${userId}: ${pc.connectionState}`);
      peer.lastConnectionAttempt = Date.now();

      if (pc.connectionState === 'connected') {
        peer.retryCount = 0; // Reset retry count on successful connection
        clearTimeout(connectionTimeout);
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.reconnectPeer(userId);
      } else if (pc.connectionState === 'closed') {
        this.closePeerConnection(userId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[ICE] Connection state for user ${userId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        this.reconnectPeer(userId);
      }
    };

    // Only non-admins add tracks to share with admins
    if (!this.isAdmin) {
      this.updatePeerTracks(peer);
    }

    // Only non-admins initiate the offer
    if (!this.isAdmin) {
      this.negotiateConnection(userId);
    }
  }

  private async sendIceCandidateWithRetry(userId: number, candidate: RTCIceCandidate, attempt: number = 1) {
    try {
      this.socketService.sendMessage(
        JSON.stringify({
          type: 'ice-candidate',
          sender: this.userId,
          receiver: userId,
          candidate: candidate,
          attempt
        }),
        false,
        'audioRoom'
      );
    } catch (error) {
      console.error(`[ICE] Failed to send candidate to ${userId}, attempt ${attempt}:`, error);
      if (attempt < this.MAX_RETRIES) {
        const delay = this.BASE_RETRY_DELAY * Math.pow(2, attempt);
        setTimeout(() => {
          this.sendIceCandidateWithRetry(userId, candidate, attempt + 1);
        }, delay);
      } else {
        console.error(`[ICE] Max retries reached for candidate to ${userId}`);
        this.reconnectPeer(userId);
      }
    }
  }

  private updatePeerTracks(peer: PeerConnection) {
    if (!this.isAdmin && this.localStream) {
      this.localStream.getTracks().forEach(track => {
        if (!peer.pc.getSenders().some(s => s.track === track)) {
          console.log(`[Track] Adding track to peer ${peer.displayName}`);
          peer.pc.addTrack(track, this.localStream!);
        }
      });
    }
  }

  private updateVideoElements(userId: number) {
    if (!this.isAdmin) return; // Only admins display videos
    const userContainer = this.remoteVideoContainers.find(
      container => (container.nativeElement.closest('.user') as HTMLElement | null)?.dataset.userId === userId.toString()
    )?.nativeElement.querySelector('.remote-video');
    if (!userContainer) {
      console.warn(`[Video] No container found for user ${userId}`);
      return;
    }

    const streams = this.remoteStreams.get(userId) || {};
    const existingVideos = userContainer.querySelectorAll(`video[data-user-id="${userId}"]`);
    existingVideos.forEach(video => video.remove());

    if (streams.screen) {
      console.log(`[Video] Adding screen stream for user ${userId}`);
      const screenVideo = document.createElement('video');
      screenVideo.classList.add('screen-share');
      screenVideo.dataset.userId = userId.toString();
      screenVideo.autoplay = true;
      screenVideo.playsInline = true;
      screenVideo.srcObject = streams.screen;
      userContainer.appendChild(screenVideo);
      this.safePlayVideo(screenVideo);
    } else {
      console.warn(`[Video] No screen stream available for user ${userId}`);
    }
    this.debounceChangeDetection();
  }

  joinaudioRoom() {
    this.joinTestRoom(); // Maintain backward compatibility
  }

  startTest() {
    if (!this.isAdmin) return;
    console.log('[Test] Admin starting test');
    this.isTestStarted = true;
    this.socketService.sendMessage('test_started', false, 'audioRoom');
    // Admins don't create connections; wait for users to initiate
    this.debounceChangeDetection();
  }

  async startScreenShare() {
    if (this.isScreenSharing || this.isAdmin) return;
    console.log('[ScreenShare] Starting screen share');
    try {
      if (this.electronService.isElectron()) {
        // Check screen recording permission on macOS
        if (process.platform === 'darwin') {
          const status = await (window as any).electronAPI.checkScreenPermission();
          if (status !== 'granted') {
            alert('Please enable screen recording permission in System Preferences > Security & Privacy > Privacy > Screen Recording.');
            throw new Error('Screen recording permission denied');
          }
        }

        // Get screen sharing sources
        const sources = await (window as any).electronAPI.getScreenSources();
        if (!sources || sources.length === 0) {
          throw new Error('No screen sharing sources available');
        }

        // Optionally: Implement a UI to let users select a source
        const source = sources[0]; // Auto-select first source (e.g., entire screen)
        this.localStream = await navigator.mediaDevices.getUserMedia({
          video: {
            // @ts-ignore: Electron desktop capture uses non-standard constraints
            chromeMediaSource: 'desktop',
            // @ts-ignore: Electron desktop capture uses non-standard constraints
            chromeMediaSourceId: source.id,
            width: { max: 1920 },
            height: { max: 1080 },
            frameRate: { max: 30 }
          } as any,
          audio: false,
        });
      } else {
        // Browser fallback
        this.localStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } },
          audio: false,
        });
      }

      this.isScreenSharing = true;
      this.localStream.getVideoTracks()[0].contentHint = 'detail';
      this.localStream.getTracks().forEach(track => {
        track.addEventListener('ended', () => {
          this.stopScreenShare();
        });
      });
      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = this.localStream;
        this.safePlayVideo(this.localVideoRef.nativeElement);
      }
      this.peerConnections.forEach((peer, userId) => {
        if (this.users.find(u => u.id === userId)?.isAdmin) {
          this.updatePeerTracks(peer);
          if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
            this.negotiateConnection(userId);
          }
        }
      });
    } catch (err) {
      console.error('[ScreenShare] Failed to share screen:', err);
      this.isScreenSharing = false;
      alert('Screen sharing failed. Please ensure screen recording permissions are granted.');
    }
    this.debounceChangeDetection();
  }

  stopScreenShare() {
    if (!this.isScreenSharing) return;
    console.log('[ScreenShare] Stopping screen share');
    this.localStream?.getTracks().forEach(track => track.stop());
    this.localStream = undefined;
    this.isScreenSharing = false;
    if (this.localVideoRef?.nativeElement) {
      this.localVideoRef.nativeElement.srcObject = null;
    }
    this.peerConnections.forEach((peer, userId) => {
      if (this.users.find(u => u.id === userId)?.isAdmin) {
        this.updatePeerTracks(peer);
        if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
          this.negotiateConnection(userId);
        }
      }
    });
    this.debounceChangeDetection();
  }

  private async negotiateConnection(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (!peer || peer.pc.signalingState !== 'stable' || this.negotiationLock.get(userId)) {
      console.log(`[Negotiation] Skipping for user ${userId}, state: ${peer?.pc.signalingState}, locked: ${this.negotiationLock.get(userId)}`);
      return;
    }
    this.negotiationLock.set(userId, true);
    try {
      console.log(`[Negotiation] Creating offer for user ${userId}`);
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      this.socketService.sendMessage(
        JSON.stringify({
          type: 'offer',
          sender: this.userId,
          receiver: userId,
          sdp: offer.sdp
        }),
        false,
        'audioRoom'
      );
    } catch (error) {
      console.error('[Negotiation] Error:', error);
      this.reconnectPeer(userId);
    } finally {
      this.negotiationLock.set(userId, false);
    }
  }

  private async handleSignalingData(data: any) {
    const senderId = parseInt(data.sender);
    const receiverId = parseInt(data.receiver);
    if (receiverId !== parseInt(this.userId) || !this.testUserIds.has(senderId) || senderId === parseInt(this.userId)) {
      console.log(`[Signaling] Ignoring data: receiver=${receiverId}, sender=${senderId}`);
      return;
    }

    const sender = this.users.find(u => u.id === senderId);
    if (!sender || (this.isAdmin && sender.isAdmin) || (!this.isAdmin && !sender.isAdmin)) {
      console.log(`[Signaling] Ignoring invalid sender: isAdmin=${this.isAdmin}, senderIsAdmin=${sender?.isAdmin}`);
      return;
    }

    console.log(`[Signaling] Handling ${data.type} from user ${senderId}`);
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
      default:
        console.warn(`[Signaling] Unknown type: ${data.type}`);
    }
  }

  private async handleOffer(userId: number, data: any) {
    let peer = this.peerConnections.get(userId);
    if (!peer && this.isAdmin && !this.users.find(u => u.id === userId)?.isAdmin) {
      console.log(`[Offer] Creating peer connection for user ${userId}`);
      this.createPeerConnection(userId);
      peer = this.peerConnections.get(userId);
    }
    if (!peer || this.negotiationLock.get(userId)) {
      console.warn(`[Offer] Skipping for user ${userId}: no peer or locked`);
      return;
    }
    this.negotiationLock.set(userId, true);
    try {
      if (peer.pc.signalingState !== 'stable') {
        console.log(`[Offer] Rolling back due to state: ${peer.pc.signalingState}`);
        await peer.pc.setLocalDescription({ type: 'rollback' });
      }
      console.log(`[Offer] Setting remote description for user ${userId}`);
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.socketService.sendMessage(
        JSON.stringify({
          type: 'answer',
          sender: this.userId,
          receiver: userId,
          sdp: answer.sdp
        }),
        false,
        'audioRoom'
      );

      // Process any pending ICE candidates
      const candidates = this.pendingCandidates.get(userId) || [];
      for (const candidate of candidates) {
        console.log(`[Offer] Adding queued candidate for user ${userId}`);
        await peer.pc.addIceCandidate(candidate).catch(error => console.error(`[ICE ${userId}] Error:`, error));
      }
      this.pendingCandidates.set(userId, []);
    } catch (error) {
      console.error(`[Offer ${userId}] Error:`, error);
      this.reconnectPeer(userId);
    } finally {
      this.negotiationLock.set(userId, false);
    }
  }

  private async handleAnswer(userId: number, data: any) {
    const peer = this.peerConnections.get(userId);
    if (!peer || peer.pc.signalingState !== 'have-local-offer') {
      console.warn(`[Answer] Invalid state for user ${userId}: ${peer?.pc.signalingState}`);
      return;
    }
    try {
      console.log(`[Answer] Setting remote description for user ${userId}`);
      await peer.pc.setRemoteDescription(new RTCSessionDescription(data));
    } catch (error) {
      console.error(`[Answer ${userId}] Error:`, error);
      this.reconnectPeer(userId);
    }
  }

  private async handleCandidate(userId: number, candidate: any) {
    let peer = this.peerConnections.get(userId);
    if (!peer && this.isAdmin && !this.users.find(u => u.id === userId)?.isAdmin) {
      console.log(`[ICE] Creating peer connection for user ${userId} due to candidate`);
      this.createPeerConnection(userId);
      peer = this.peerConnections.get(userId);
    }
    if (!peer) {
      console.warn(`[ICE] No peer for user ${userId}`);
      this.reconnectPeer(userId);
      return;
    }
    const rtcCandidate = new RTCIceCandidate(candidate);
    if (peer.pc.remoteDescription && peer.pc.signalingState !== 'closed') {
      console.log(`[ICE] Adding candidate for user ${userId}`);
      try {
        await peer.pc.addIceCandidate(rtcCandidate);
      } catch (error) {
        console.error(`[ICE ${userId}] Error adding candidate:`, error);
        if (candidate.attempt < this.MAX_RETRIES) {
          const delay = this.BASE_RETRY_DELAY * Math.pow(2, candidate.attempt || 1);
          setTimeout(() => {
            this.sendIceCandidateWithRetry(userId, rtcCandidate, (candidate.attempt || 1) + 1);
          }, delay);
        } else {
          console.error(`[ICE] Max retries reached for candidate to ${userId}`);
          this.reconnectPeer(userId);
        }
      }
    } else {
      console.log(`[ICE] Queuing candidate for user ${userId}`);
      const pending = this.pendingCandidates.get(userId) || [];
      pending.push(rtcCandidate);
      this.pendingCandidates.set(userId, pending);
    }
  }

  private closePeerConnection(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (peer) {
      console.log(`[Peer] Closing connection for user ${userId}`);
      peer.pc.close();
      const streams = this.remoteStreams.get(userId);
      if (streams?.screen) {
        streams.screen.getTracks().forEach(track => track.stop());
      }
      this.remoteStreams.delete(userId);
      const userContainer = this.remoteVideoContainers.find(
        container => (container.nativeElement.closest('.user') as HTMLElement | null)?.dataset.userId === userId.toString()
      )?.nativeElement.querySelector('.remote-video');
      if (userContainer) {
        const videos = userContainer.querySelectorAll(`video[data-user-id="${userId}"]`);
        videos.forEach(video => video.remove());
      }
      this.peerConnections.delete(userId);
      this.pendingCandidates.delete(userId);
      this.negotiationLock.delete(userId);
    }
  }

  private reconnectPeer(userId: number) {
    const peer = this.peerConnections.get(userId);
    if (!this.isInTest || !this.testUserIds.has(userId) || !peer) {
      console.log(`[Reconnect] Skipping reconnect for user ${userId}: not in test or no peer`);
      return;
    }

    if (peer.retryCount >= this.MAX_RETRIES) {
      console.error(`[Reconnect] Max retries reached for user ${userId}`);
      this.closePeerConnection(userId);
      return;
    }

    const now = Date.now();
    const delay = this.BASE_RETRY_DELAY * Math.pow(2, peer.retryCount);
    if (now - peer.lastConnectionAttempt < delay) {
      console.log(`[Reconnect] Waiting for backoff period for user ${userId}`);
      return;
    }

    console.log(`[Reconnect] Attempting reconnect to user ${userId}, attempt ${peer.retryCount + 1}`);
    peer.retryCount++;
    peer.lastConnectionAttempt = now;
    this.closePeerConnection(userId);

    setTimeout(() => {
      if (this.isInTest && this.testUserIds.has(userId)) {
        this.createPeerConnection(userId);
      }
    }, delay + Math.random() * 100); // Add jitter
  }

  leaveTest() {
    console.log('[Test] Leaving test');
    this.peerConnections.forEach((_, userId) => this.closePeerConnection(userId));
    this.stopScreenShare();
    this.isInTest = false;
    if (this.isAdmin) this.isTestStarted = false;
    if (this.localVideoRef?.nativeElement) {
      this.localVideoRef.nativeElement.srcObject = null;
    }
    this.audioContainerRef.nativeElement.innerHTML = '';
    this.remoteStreams.clear();
    this.socketService.sendMessage(`user_joined_call:&${this.userId}`, false, 'audioRoom');
    this.debounceChangeDetection();
  }

  private startWindowTracking() {
    this.windowCheckInterval = setInterval(async () => {
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
      if (!aWindow) return 1;
      if (!bWindow) return -1;
      return bWindow.timestamp - aWindow.timestamp;
    });
  }

  getActiveWindowTitle(userId: number): string | null {
    const window = this.activeWindows.find(w => w.userId === userId);
    return window ? window.windowTitle : null;
  }

  private safePlayVideo(element: HTMLVideoElement) {
    if (element.srcObject) {
      element.play().catch(err => {
        console.error('[Video] Play error:', err);
        if (err.name === 'NotAllowedError') {
          document.addEventListener('click', () => element.play().catch(e => console.error('[Video] Retry play error:', e)), { once: true });
        }
      });
    }
  }

  private debounceChangeDetection() {
    if (this.changeDetectionTimeout) clearTimeout(this.changeDetectionTimeout);
    this.changeDetectionTimeout = setTimeout(() => {
      console.log('[CD] Triggering change detection');
      this.cdr.detectChanges();
    }, 100);
  }
}
