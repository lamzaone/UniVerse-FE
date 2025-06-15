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
    audio?: MediaStreamTrack;
    screen?: MediaStreamTrack;
    camera?: MediaStreamTrack;
  };
  displayName: string;
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
  screenStream?: MediaStream;
  cameraStream?: MediaStream;

  peerConnections = new Map<number, PeerConnection>();
  remoteStreams = new Map<number, { screen?: MediaStream, camera?: MediaStream }>();
  pendingCandidates = new Map<number, RTCIceCandidate[]>();

  isInTest = false;
  isTestStarted = false;
  isScreenSharing = false;
  isCameraEnabled = false;
  isMicMuted = false;

  private changeDetectionTimeout: any;
  private negotiationLock = new Map<number, boolean>();
  private windowCheckInterval: any;

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

  async joinTestRoom() {
    if (this.isInTest) return;
    console.log('[Test] Joining test room');
    try {
      const mediaPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      this.isInTest = true;
      this.socketService.sendMessage(`user_joined_call:&${this.userId}`, false, 'audioRoom');
      this.testUserIds.add(parseInt(this.userId));

      this.localStream = await mediaPromise;
      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = this.localStream;
        this.localVideoRef.nativeElement.muted = true;
        this.safePlayVideo(this.localVideoRef.nativeElement);
      }

      // Create connections to all users for audio
      this.users.forEach(user => {
        if (user.id !== parseInt(this.userId)) {
          this.createPeerConnection(user.id);
        }
      });

      if (this.isTestStarted && !this.isAdmin) {
        await this.startScreenShare();
      }

      this.debounceChangeDetection();
    } catch (err) {
      console.error('[Test] Failed to join test room:', err);
      this.isInTest = false;
      alert('Failed to access microphone.');
      this.debounceChangeDetection();
    }
  }

  private setupSocketListeners() {
    console.log('[Socket] Setting up socket listeners');
    this.socketService.onAudioRoomMessage((message: string) => {
      // console.log('[Socket] Received message:', message);
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
      if (this.isInTest) {
        this.createPeerConnection(userId);
      }
      this.debounceChangeDetection();
    }
  }

  private handleUserLeft(userId: number) {
    console.log(`[User] User ${userId} left test`);
    this.testUserIds.delete(userId);
    this.closePeerConnection(userId);
    this.fetchInitialUsers();
    this.debounceChangeDetection();
  }

  private async handleTestStarted() {
    console.log('[Test] Test started by admin');
    this.isTestStarted = true;
    if (this.isInTest && !this.isAdmin) {
      await this.startScreenShare();
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
    if (!user || userId === parseInt(this.userId)) {
      console.log(`[Peer] Skipping connection to ${userId}: invalid user or self`);
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
        }
      ]
    });
    const peer: PeerConnection = { pc, streams: {}, displayName };
    this.peerConnections.set(userId, peer);
    this.pendingCandidates.set(userId, []);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`[ICE] Sending candidate to user ${userId}`);
        this.socketService.sendMessage(
          JSON.stringify({
            type: 'ice-candidate',
            sender: this.userId,
            receiver: userId,
            candidate: event.candidate
          }),
          false,
          'audioRoom'
        );
      }
    };

    pc.ontrack = (event) => {
      console.log(`[Track] Received track from user ${userId}:`, event.track.kind);
      const stream = event.streams[0];
      const isScreen = event.track.kind === 'video' && event.track.contentHint === 'detail';
      if (event.track.kind === 'audio') {
        this.addAudioElement(userId, stream);
      } else if (event.track.kind === 'video' && this.isAdmin) {
        const current = this.remoteStreams.get(userId) || {};
        if (isScreen) {
          current.screen = stream;
        } else {
          current.camera = stream;
        }
        this.remoteStreams.set(userId, current);
        this.updateVideoElements(userId);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[Connection] State for user ${userId}: ${pc.connectionState}`);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        setTimeout(() => this.reconnectPeer(userId), 1000);
      } else if (pc.connectionState === 'closed') {
        this.closePeerConnection(userId);
      }
    };

    // Add audio track for all connections
    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        pc.addTrack(audioTrack, this.localStream);
      }
    }

    // Add video tracks if we're non-admin connecting to admin
    if (!this.isAdmin && user.isAdmin) {
      this.updatePeerVideoTracks(peer);
    }

    // Non-admins initiate connection to admins
    if (!this.isAdmin && user.isAdmin) {
      this.negotiateConnection(userId);
    }
  }

  private updatePeerVideoTracks(peer: PeerConnection) {
    const tracks: MediaStreamTrack[] = [];
    if (this.screenStream) {
      tracks.push(...this.screenStream.getVideoTracks());
    }
    if (this.cameraStream) {
      tracks.push(...this.cameraStream.getVideoTracks());
    }
    tracks.forEach(track => {
      if (!peer.pc.getSenders().some(s => s.track === track)) {
        console.log(`[Track] Adding video track to peer ${peer.displayName}: ${track.kind}`);
        peer.pc.addTrack(track, new MediaStream([track]));
      }
    });
  }

  private addAudioElement(userId: number, stream: MediaStream) {
    const existingAudio = this.audioContainerRef.nativeElement.querySelector(`audio[data-user-id="${userId}"]`);
    if (!existingAudio) {
      const audio = document.createElement('audio');
      audio.srcObject = stream;
      audio.autoplay = true;
      audio.dataset.userId = userId.toString();
      this.audioContainerRef.nativeElement.appendChild(audio);
    }
  }

  private updateVideoElements(userId: number) {
    const userContainer = this.remoteVideoContainers.find(
      container => (container.nativeElement.closest('.user') as HTMLElement | null)?.dataset.userId === userId.toString()
    )?.nativeElement.querySelector('.remote-video');
    if (!userContainer) {
      console.warn(`[Video] No container found for user ${userId}`);
      return;
    }

    const streams = this.remoteStreams.get(userId) || {};

    // Clear only specific streams we're about to replace
    const existingScreen = userContainer.querySelector(`video.screen-share[data-user-id="${userId}"]`);
    const existingCamera = userContainer.querySelector(`video.camera-video[data-user-id="${userId}"]`);

    // Add screen stream if available
    if (streams.screen) {
      if (!existingScreen) {
        console.log(`[Video] Adding screen stream for user ${userId}`);
        const screenVideo = document.createElement('video');
        screenVideo.classList.add('screen-share');
        screenVideo.dataset.userId = userId.toString();
        screenVideo.autoplay = true;
        screenVideo.playsInline = true;
        screenVideo.srcObject = streams.screen;
        userContainer.appendChild(screenVideo);
        this.safePlayVideo(screenVideo);
      } else if ((existingScreen as HTMLVideoElement).srcObject !== streams.screen) {
        (existingScreen as HTMLVideoElement).srcObject = streams.screen;
        this.safePlayVideo(existingScreen as HTMLVideoElement);
      }
    } else if (existingScreen) {
      existingScreen.remove();
    }

    // Add camera stream if available (positioned below screen)
    if (streams.camera) {
      if (!existingCamera) {
        console.log(`[Video] Adding camera stream for user ${userId}`);
        const cameraVideo = document.createElement('video');
        cameraVideo.classList.add('camera-video');
        cameraVideo.dataset.userId = userId.toString();
        cameraVideo.autoplay = true;
        cameraVideo.playsInline = true;
        cameraVideo.srcObject = streams.camera;
        // Insert after screen share or at the end if no screen share
        const referenceNode = existingScreen || null;
        userContainer.insertBefore(cameraVideo, referenceNode?.nextSibling || null);
        this.safePlayVideo(cameraVideo);
      } else if ((existingCamera as HTMLVideoElement).srcObject !== streams.camera) {
        (existingCamera as HTMLVideoElement).srcObject = streams.camera;
        this.safePlayVideo(existingCamera as HTMLVideoElement);
      }
    } else if (existingCamera) {
      existingCamera.remove();
    }

    this.debounceChangeDetection();
  }

  joinaudioRoom() {
    this.joinTestRoom();
  }

  startTest() {
    if (!this.isAdmin || this.isTestStarted) return;
    console.log('[Test] Admin starting test');
    this.isTestStarted = true;
    this.socketService.sendMessage('test_started', false, 'audioRoom');
    this.debounceChangeDetection();
  }

  async startScreenShare() {
    if (this.isScreenSharing || this.isAdmin) return;
    console.log('[ScreenShare] Starting screen and camera share');
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } },
        audio: false
      });
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { max: 320 }, height: { max: 240 }, frameRate: { max: 30 } }
      });

      this.isScreenSharing = true;
      this.isCameraEnabled = true;
      this.screenStream.getVideoTracks()[0].contentHint = 'detail';
      this.screenStream.getTracks().forEach(track => {
        track.addEventListener('ended', () => {
          this.stopScreenShare();
        });
      });

      if (this.localStream) {
        const newStream = new MediaStream([
          ...this.localStream.getAudioTracks(),
          ...this.screenStream.getVideoTracks(),
          ...this.cameraStream.getVideoTracks()
        ]);
        this.localStream.getVideoTracks().forEach(track => track.stop());
        this.localStream = newStream;
      } else {
        this.localStream = new MediaStream([
          ...this.screenStream.getVideoTracks(),
          ...this.cameraStream.getVideoTracks()
        ]);
      }

      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = this.localStream;
        this.safePlayVideo(this.localVideoRef.nativeElement);
      }

      // Update video tracks for admin connections only
      this.peerConnections.forEach((peer, userId) => {
        const user = this.users.find(u => u.id === userId);
        if (user?.isAdmin) {
          this.updatePeerVideoTracks(peer);
          if (peer.pc.signalingState === 'stable' && !this.negotiationLock.get(userId)) {
            this.negotiateConnection(userId);
          }
        }
      });
    } catch (err) {
      console.error('[ScreenShare] Failed to share screen or camera:', err);
      this.isScreenSharing = false;
      this.isCameraEnabled = false;
      this.screenStream?.getTracks().forEach(track => track.stop());
      this.cameraStream?.getTracks().forEach(track => track.stop());
      this.screenStream = undefined;
      this.cameraStream = undefined;
      alert('Screen or camera sharing failed.');
    }
    this.debounceChangeDetection();
  }

  stopScreenShare() {
    if (!this.isScreenSharing) return;
    console.log('[ScreenShare] Stopping screen and camera share');
    this.screenStream?.getTracks().forEach(track => track.stop());
    this.cameraStream?.getTracks().forEach(track => track.stop());
    this.screenStream = undefined;
    this.cameraStream = undefined;
    this.isScreenSharing = false;
    this.isCameraEnabled = false;

    if (this.localStream) {
      const newStream = new MediaStream([...this.localStream.getAudioTracks()]);
      this.localStream.getVideoTracks().forEach(track => track.stop());
      this.localStream = newStream;
      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = this.localStream;
        this.safePlayVideo(this.localVideoRef.nativeElement);
      }
    } else {
      if (this.localVideoRef?.nativeElement) {
        this.localVideoRef.nativeElement.srcObject = null;
      }
    }

    // Update video tracks for admin connections only
    this.peerConnections.forEach((peer, userId) => {
      const user = this.users.find(u => u.id === userId);
      if (user?.isAdmin) {
        this.updatePeerVideoTracks(peer);
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
    if (!sender) return;

    // Admins only process video from non-admins
    if (this.isAdmin && sender.isAdmin && data.type !== 'ice-candidate' && data.type !== 'offer') {
      console.log(`[Signaling] Admin ignoring non-audio from other admin`);
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
    if (!peer) {
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
    }
  }

  private async handleCandidate(userId: number, candidate: any) {
    let peer = this.peerConnections.get(userId);
    if (!peer) {
      console.log(`[ICE] Creating peer connection for user ${userId} due to candidate`);
      this.createPeerConnection(userId);
      peer = this.peerConnections.get(userId);
    }
    if (!peer) {
      console.warn(`[ICE] No peer for user ${userId}`);
      return;
    }
    const rtcCandidate = new RTCIceCandidate(candidate);
    if (peer.pc.remoteDescription && peer.pc.signalingState !== 'closed') {
      console.log(`[ICE] Adding candidate for user ${userId}`);
      await peer.pc.addIceCandidate(rtcCandidate).catch(error => console.error(`[ICE ${userId}] Error:`, error));
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
      if (streams?.camera) {
        streams.camera.getTracks().forEach(track => track.stop());
      }
      this.remoteStreams.delete(userId);
      const userContainer = this.remoteVideoContainers.find(
        container => (container.nativeElement.closest('.user') as HTMLElement | null)?.dataset.userId === userId.toString()
      )?.nativeElement.querySelector('.remote-video');
      if (userContainer) {
        const videos = userContainer.querySelectorAll(`video[data-user-id="${userId}"]`);
        videos.forEach(video => video.remove());
      }
      const audioElements = this.audioContainerRef.nativeElement.querySelectorAll(`audio[data-user-id="${userId}"]`);
      audioElements.forEach(audio => audio.remove());
      this.peerConnections.delete(userId);
      this.pendingCandidates.delete(userId);
      this.negotiationLock.delete(userId);
    }
  }

  private reconnectPeer(userId: number) {
    if (this.isInTest && this.testUserIds.has(userId)) {
      this.closePeerConnection(userId);
      setTimeout(() => {
        if (this.isInTest && this.testUserIds.has(userId)) {
          this.createPeerConnection(userId);
        }
      }, 1000 + Math.random() * 2000);
    }
  }

  leaveTest() {
    console.log('[Test] Leaving test');
    this.peerConnections.forEach((_, userId) => this.closePeerConnection(userId));
    this.localStream?.getTracks().forEach(track => track.stop());
    this.screenStream?.getTracks().forEach(track => track.stop());
    this.cameraStream?.getTracks().forEach(track => track.stop());
    this.localStream = undefined;
    this.screenStream = undefined;
    this.cameraStream = undefined;
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
    this.socketService.sendMessage(`user_left_call:&${this.userId}`, false, 'audioRoom');
    this.debounceChangeDetection();
  }

  toggleMic() {
    this.isMicMuted = !this.isMicMuted;
    this.localStream?.getTracks().forEach(track => {
      if (track.kind === 'audio') {
        track.enabled = !this.isMicMuted;
      }
    });
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
