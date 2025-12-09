/**
 * VibeConnect - Refactored Client Application
 * 
 * Modern, modular architecture with:
 * - Reactive state management
 * - Robust WebSocket handling with auto-reconnect
 * - Enhanced security features
 * - Performance optimizations
 * - Global error handling
 */

// Global Error Handler
window.addEventListener('error', (event) => {
  console.error('Global error:', {
    message: event.error?.message || event.message,
    stack: event.error?.stack,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    timestamp: new Date().toISOString()
  });

  // Show user-friendly error notification
  const errorMsg = event.error?.message || 'An unexpected error occurred';
  console.warn('User-facing error:', errorMsg);

  // Could send to error reporting service here
  // Example: sendToErrorService({ error: event.error, context: {...} });
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', {
    reason: event.reason,
    promise: event.promise,
    timestamp: new Date().toISOString()
  });

  // Prevent default to avoid console noise
  event.preventDefault();

  // Could send to error reporting service here
});

// Initialize managers
const stateManager = new StateManager();
const securityHelper = new SecurityHelper();

// Initialize user ID and fingerprint
if (!stateManager.get('userId')) {
  stateManager.set('userId', securityHelper.generateUserId(), true);
}

if (!stateManager.get('fingerprint')) {
  stateManager.set('fingerprint', securityHelper.generateFingerprint(), true);
}

const wsManager = new WebSocketManager(stateManager);

// DOM Elements
const elements = {
  // Views
  landingView: document.getElementById('landingView'),
  textChatView: document.getElementById('textChatView'),
  videoChatView: document.getElementById('videoChatView'),

  // Landing page
  textChatBtn: document.getElementById('textChatBtn'),
  videoChatBtn: document.getElementById('videoChatBtn'),
  userCount: document.getElementById('userCount'),
  muteBtn: document.getElementById('muteBtn'),
  connectionStatus: document.getElementById('connectionStatus'),

  // Text chat
  messageContainer: document.getElementById('messageContainer'),
  messageInput: document.getElementById('messageInput'),
  sendBtn: document.getElementById('sendBtn'),
  textStatus: document.getElementById('textStatus'),
  textBackBtn: document.getElementById('textBackBtn'),
  textNextBtn: document.getElementById('textNextBtn'),
  textReportBtn: document.getElementById('textReportBtn'),
  typingIndicator: document.getElementById('typingIndicator'),
  videoRequestBtn: document.getElementById('videoRequestBtn'),

  // Video chat
  localVideo: document.getElementById('localVideo'),
  remoteVideo: document.getElementById('remoteVideo'),
  videoStatus: document.getElementById('status'),
  videoBackBtn: document.getElementById('videoBackBtn'),
  videoSpinner: document.getElementById('videoSpinner'),
  nextBtn: document.getElementById('nextBtn'),
  reportBtn: document.getElementById('reportBtn'),

  // Modals
  termsModal: document.getElementById('termsModal'),
  termsCancelBtn: document.getElementById('termsCancelBtn'),
  termsAgreeBtn: document.getElementById('termsAgreeBtn'),
  termsCheckbox: document.getElementById('termsCheckbox'),
  videoRequestModal: document.getElementById('videoRequestModal'),
  requestModalTitle: document.getElementById('requestModalTitle'),
  requestModalMessage: document.getElementById('requestModalMessage'),
  acceptVideoBtn: document.getElementById('acceptVideoBtn'),
  declineVideoBtn: document.getElementById('declineVideoBtn')
};

// WebRTC variables
let localStream = null;
let peerConnection = null;
let iceCandidatesBuffer = [];
let isOfferer = false;

// WebRTC configuration - Multiple STUN servers for better connectivity
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.services.mozilla.com' }
  ],
  iceCandidatePoolSize: 10, // Pre-gather ICE candidates for faster connection
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

// Typing timeout
let typingTimeout = null;

// Video request state
let videoRequestPending = false;

// ===== State Observers =====

// Connection status observer
stateManager.subscribe('connectionStatus', (status) => {
  elements.connectionStatus.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  elements.connectionStatus.className = 'connection-status ' + status;
});

// Connected observer
stateManager.subscribe('connected', (connected) => {
  elements.textChatBtn.disabled = !connected;
  elements.videoChatBtn.disabled = !connected;
});

// User count observer
stateManager.subscribe('userCount', (count) => {
  elements.userCount.textContent = `🟢 ${count} users online`;
});

// Mute observer
stateManager.subscribe('isMuted', (isMuted) => {
  elements.muteBtn.textContent = isMuted ? '🔇' : '🔊';
  elements.muteBtn.classList.toggle('muted', isMuted);
});

// ===== WebSocket Event Handlers =====

wsManager.on('waiting', () => {
  const mode = stateManager.get('currentMode');
  const statusElement = mode === 'video' ? elements.videoStatus : elements.textStatus;
  updateStatus(statusElement, 'Waiting for a partner...');
});

wsManager.on('paired', (data) => {
  stateManager.setMultiple({
    partnerId: data.partnerId,
    partnerConnected: true
  });

  playNotificationSound();

  const mode = stateManager.get('currentMode');

  if (mode === 'text') {
    updateStatus(elements.textStatus, 'Connected! You can now chat.');
    elements.messageInput.disabled = false;
    elements.sendBtn.disabled = false;
    elements.textNextBtn.disabled = false;
    elements.textReportBtn.disabled = false;
    elements.videoRequestBtn.disabled = false;
    elements.messageInput.focus();
  } else if (mode === 'video') {
    isOfferer = data.isOfferer;
    updateStatus(elements.videoStatus, 'Connected! Starting video...');
    elements.nextBtn.disabled = false;
    elements.reportBtn.disabled = false;
    startWebRTC();
  }
});

wsManager.on('text-message', (data) => {
  displayMessage(data.message, false);
});

wsManager.on('offer', (data) => {
  handleOffer(data);
});

wsManager.on('answer', (data) => {
  handleAnswer(data);
});

wsManager.on('ice-candidate', (data) => {
  handleIceCandidate(data);
});

wsManager.on('partner-disconnected', () => {
  handlePartnerDisconnect();
});

wsManager.on('user-count', (data) => {
  stateManager.set('userCount', data.count || 0);
});

wsManager.on('typing-start', () => {
  if (stateManager.get('currentMode') === 'text') {
    elements.typingIndicator.style.display = 'block';
  }
});

wsManager.on('typing-stop', () => {
  if (stateManager.get('currentMode') === 'text') {
    elements.typingIndicator.style.display = 'none';
  }
});

wsManager.on('error', (data) => {
  console.error('Server error:', data.message);
  const mode = stateManager.get('currentMode');
  const statusElement = mode === 'video' ? elements.videoStatus : elements.textStatus;
  updateStatus(statusElement, `Error: ${data.message}`, true);
  setTimeout(() => updateStatus(statusElement, ''), 3000);
});

wsManager.on('warning', (data) => {
  console.warn('Server warning:', data.message);
  alert(`⚠️ Warning: ${data.message}`);
});

wsManager.on('video-request', (data) => {
  receiveVideoRequest(data);
});

wsManager.on('video-request-accept', () => {
  handleVideoRequestAccepted();
});

wsManager.on('video-request-decline', () => {
  handleVideoRequestDeclined();
});

wsManager.on('video-request-cancel', () => {
  elements.videoRequestModal.style.display = 'none';
  displaySystemMessage('Partner cancelled the video request.');
});

wsManager.on('video-mode-ready', (data) => {
  handleVideoModeReady(data);
});

// ===== Event Listeners =====

elements.textChatBtn.addEventListener('click', () => showTermsModal('text'));
elements.videoChatBtn.addEventListener('click', () => showTermsModal('video'));
elements.termsCancelBtn.addEventListener('click', hideTermsModal);
elements.termsAgreeBtn.addEventListener('click', handleTermsAgree);
elements.sendBtn.addEventListener('click', sendMessage);
elements.messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !elements.sendBtn.disabled) sendMessage();
});
elements.textBackBtn.addEventListener('click', returnToLanding);
elements.videoBackBtn.addEventListener('click', returnToLanding);
elements.textNextBtn.addEventListener('click', skipPartner);
elements.textReportBtn.addEventListener('click', reportUser);
elements.nextBtn.addEventListener('click', skipPartner);
elements.reportBtn.addEventListener('click', reportUser);
elements.muteBtn.addEventListener('click', toggleMute);
elements.messageInput.addEventListener('input', handleTyping);
elements.termsCheckbox.addEventListener('change', () => {
  elements.termsAgreeBtn.disabled = !elements.termsCheckbox.checked;
});
elements.videoRequestBtn.addEventListener('click', sendVideoRequest);
elements.acceptVideoBtn.addEventListener('click', acceptVideoRequest);
elements.declineVideoBtn.addEventListener('click', declineVideoRequest);

// ===== View Management =====

function showTextChatView() {
  elements.landingView.style.display = 'none';
  elements.textChatView.style.display = 'block';
  stateManager.set('currentView', 'text');
  stateManager.set('currentMode', 'text');
  document.body.classList.add('chat-active');
}

function showVideoChatView() {
  elements.landingView.style.display = 'none';
  elements.videoChatView.style.display = 'block';
  stateManager.set('currentView', 'video');
  stateManager.set('currentMode', 'video');
}

function showLandingView() {
  elements.landingView.style.display = 'block';
  elements.textChatView.style.display = 'none';
  elements.videoChatView.style.display = 'none';
  stateManager.setMultiple({
    currentView: 'landing',
    currentMode: null,
    partnerId: null,
    partnerConnected: false
  });
  document.body.classList.remove('chat-active');
}

function showTermsModal(mode) {
  stateManager.set('pendingMode', mode);
  elements.termsModal.style.display = 'flex';
}

function hideTermsModal() {
  elements.termsModal.style.display = 'none';
  stateManager.set('pendingMode', null);
}

function handleTermsAgree() {
  const mode = stateManager.get('pendingMode');
  if (mode === 'text') {
    showTextChatView();
    startTextChat();
  } else if (mode === 'video') {
    showVideoChatView();
    startVideoChat();
  }
  hideTermsModal();
}

function returnToLanding() {
  const mode = stateManager.get('currentMode');
  if (mode === 'text') {
    stopTextChat();
  } else if (mode === 'video') {
    stopVideoChat();
  }
  showLandingView();
}

function updateStatus(element, message, isError = false) {
  if (element) {
    element.textContent = message;
    element.style.color = isError ? '#ff6b6b' : '';
  }
}

// ===== Feature Functions =====

function skipPartner() {
  console.log('Skipping to next partner...');
  const mode = stateManager.get('currentMode');
  const statusElement = mode === 'video' ? elements.videoStatus : elements.textStatus;
  updateStatus(statusElement, 'Skipping... Finding new partner...');

  if (mode === 'video') {
    elements.nextBtn.disabled = true;
    elements.reportBtn.disabled = true;
    toggleVideoSpinner(true);
  } else {
    elements.textNextBtn.disabled = true;
    elements.textReportBtn.disabled = true;
  }

  const partnerId = stateManager.get('partnerId');
  if (partnerId) {
    wsManager.send({
      type: 'disconnect',
      userId: stateManager.get('userId')
    });
    stateManager.setMultiple({
      partnerId: null,
      partnerConnected: false
    });
  }

  setTimeout(() => {
    if (mode === 'text') {
      elements.messageContainer.innerHTML = '';
      wsManager.send({
        type: 'join-text',
        userId: stateManager.get('userId')
      });
    } else if (mode === 'video') {
      wsManager.send({
        type: 'join-video',
        userId: stateManager.get('userId')
      });
    }
  }, CONSTANTS.SKIP_DELAY_MS);
}

function reportUser() {
  const partnerId = stateManager.get('partnerId');
  if (!partnerId) return;

  const reason = prompt('Report reason:\n1. Inappropriate\n2. Spam\n3. Harassment\n4. Other');
  if (reason) {
    const reportReason = ['inappropriate', 'spam', 'harassment', 'other'][parseInt(reason) - 1] || 'other';
    wsManager.send({
      type: 'report-user',
      userId: stateManager.get('userId'),
      reportedId: partnerId,
      reason: reportReason
    });

    console.log('User reported:', reportReason);
    const mode = stateManager.get('currentMode');
    const statusElement = mode === 'video' ? elements.videoStatus : elements.textStatus;
    updateStatus(statusElement, 'User reported. Disconnecting...', true);

    setTimeout(() => {
      if (mode === 'text') stopTextChat();
      else if (mode === 'video') stopVideoChat();
    }, 1500);
  }
}

function handleTyping() {
  const partnerId = stateManager.get('partnerId');
  if (!partnerId || stateManager.get('currentMode') !== 'text') return;

  wsManager.send({
    type: 'typing-start',
    userId: stateManager.get('userId'),
    targetId: partnerId
  });

  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    wsManager.send({
      type: 'typing-stop',
      userId: stateManager.get('userId'),
      targetId: partnerId
    });
  }, 2000);
}

function playNotificationSound() {
  if (stateManager.get('isMuted')) return;

  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.frequency.value = 800;
    oscillator.type = 'sine';
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.5);
  } catch (e) {
    console.error('Could not play notification sound', e);
  }
}

function toggleMute() {
  const isMuted = !stateManager.get('isMuted');
  stateManager.set('isMuted', isMuted, true);
}

// ===== Text Chat Functions =====

function startTextChat() {
  console.log('Starting text chat...');
  elements.messageContainer.innerHTML = '';
  wsManager.send({
    type: 'join-text',
    userId: stateManager.get('userId')
  });
  updateStatus(elements.textStatus, 'Joining chat...');
}

function stopTextChat() {
  console.log('Stopping text chat...');
  wsManager.send({
    type: 'disconnect',
    userId: stateManager.get('userId')
  });
  elements.messageInput.disabled = true;
  elements.sendBtn.disabled = true;
  elements.messageInput.value = '';
  updateStatus(elements.textStatus, 'Chat stopped. Go back to start again.');
  stateManager.setMultiple({
    partnerId: null,
    partnerConnected: false
  });
  elements.textNextBtn.disabled = true;
  elements.textReportBtn.disabled = true;
  elements.typingIndicator.style.display = 'none';
}

function sendMessage() {
  const message = elements.messageInput.value.trim();
  const partnerId = stateManager.get('partnerId');

  if (!message || !partnerId) return;

  // Validate and sanitize
  const { safe, sanitized } = securityHelper.processInput(message);
  if (!safe) {
    alert('Your message contains potentially dangerous content and cannot be sent.');
    return;
  }

  displayMessage(sanitized, true);
  wsManager.send({
    type: 'text-message',
    userId: stateManager.get('userId'),
    targetId: partnerId,
    message: sanitized
  });
  elements.messageInput.value = '';
  elements.messageInput.focus();
}

function displayMessage(message, isSent) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${isSent ? 'sent' : 'received'}`;
  messageDiv.textContent = message; // Prevents XSS
  elements.messageContainer.appendChild(messageDiv);
  elements.messageContainer.scrollTop = elements.messageContainer.scrollHeight;
}

function displaySystemMessage(message) {
  const systemMsg = document.createElement('div');
  systemMsg.className = 'message system-message';
  systemMsg.textContent = message;
  elements.messageContainer.appendChild(systemMsg);
  elements.messageContainer.scrollTop = elements.messageContainer.scrollHeight;
}

// ===== Video Chat Functions =====

function toggleVideoSpinner(show) {
  elements.videoSpinner.style.display = show ? 'flex' : 'none';
}

async function startVideoChat() {
  console.log('Requesting user media...');
  toggleVideoSpinner(true);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    console.log('Got local stream');
    elements.localVideo.srcObject = localStream;
    elements.localVideo.muted = true;

    wsManager.send({
      type: 'join-video',
      userId: stateManager.get('userId')
    });
    updateStatus(elements.videoStatus, 'Joining chat...');
  } catch (error) {
    console.error('Error accessing media devices:', error);
    let msg = 'Error: Could not access camera/microphone.';
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      msg = 'Error: Camera/microphone permission denied.';
    } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      msg = 'Error: No camera or microphone found.';
    } else if (error.name === 'NotReadableError') {
      msg = 'Error: Camera/microphone is already in use.';
    }
    updateStatus(elements.videoStatus, msg, true);
    toggleVideoSpinner(false);
  }
}

function stopVideoChat() {
  console.log('Stopping video chat...');
  wsManager.send({
    type: 'disconnect',
    userId: stateManager.get('userId')
  });

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }

  if (peerConnection) {
    // Remove event handlers before closing to prevent errors
    peerConnection.onicecandidate = null;
    peerConnection.ontrack = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.oniceconnectionstatechange = null;

    peerConnection.close();
    peerConnection = null;
  }

  elements.localVideo.srcObject = null;
  elements.remoteVideo.srcObject = null;
  updateStatus(elements.videoStatus, 'Chat stopped. Go back to start again.');
  stateManager.setMultiple({
    partnerId: null,
    partnerConnected: false
  });
  isOfferer = false;
  iceCandidatesBuffer = [];
  toggleVideoSpinner(false);
  elements.nextBtn.disabled = true;
  elements.reportBtn.disabled = true;
}

function startWebRTC() {
  console.log('Starting WebRTC connection...');
  peerConnection = new RTCPeerConnection(rtcConfig);

  if (localStream) {
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  }

  peerConnection.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      elements.remoteVideo.srcObject = event.streams[0];
      elements.remoteVideo.onplaying = () => {
        updateStatus(elements.videoStatus, 'Video chat active!');
        toggleVideoSpinner(false);
      };
      updateStatus(elements.videoStatus, 'Connecting video...');
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      wsManager.send({
        type: 'ice-candidate',
        userId: stateManager.get('userId'),
        targetId: stateManager.get('partnerId'),
        candidate: event.candidate
      });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    // Check if peerConnection still exists (might be cleaned up)
    if (!peerConnection) {
      return;
    }

    console.log(`Peer connection state: ${peerConnection.connectionState}`);

    if (peerConnection.connectionState === 'connected') {
      if (window.connectionTimeout) {
        clearTimeout(window.connectionTimeout);
        window.connectionTimeout = null;
      }
      updateStatus(elements.videoStatus, 'Video chat active!');
      toggleVideoSpinner(false);
    } else if (peerConnection.connectionState === 'failed') {
      if (window.connectionTimeout) {
        clearTimeout(window.connectionTimeout);
        window.connectionTimeout = null;
      }
      updateStatus(elements.videoStatus, 'Connection failed. Please try again.', true);
      toggleVideoSpinner(false);
    } else if (peerConnection.connectionState === 'disconnected') {
      if (window.connectionTimeout) {
        clearTimeout(window.connectionTimeout);
        window.connectionTimeout = null;
      }
      handlePartnerDisconnect();
    }
  };

  // Set 10-second timeout for connection (reduced from 15s for faster feedback)
  window.connectionTimeout = setTimeout(() => {
    if (peerConnection && peerConnection.connectionState !== 'connected') {
      console.error('WebRTC connection timeout');
      updateStatus(elements.videoStatus, 'Connection timeout. Please try again.', true);
      toggleVideoSpinner(false);

      if (peerConnection) {
        // Remove event handlers before closing
        peerConnection.onicecandidate = null;
        peerConnection.ontrack = null;
        peerConnection.onconnectionstatechange = null;
        peerConnection.oniceconnectionstatechange = null;

        peerConnection.close();
        peerConnection = null;
      }

      elements.nextBtn.disabled = false;
      elements.reportBtn.disabled = false;
    }
  }, 10000); // 10 second timeout (reduced from 15s)


  if (isOfferer) {
    console.log('User is offerer, creating offer...');
    peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    })
      .then(offer => peerConnection.setLocalDescription(offer))
      .then(() => {
        console.log('Sending offer...');
        wsManager.send({
          type: 'offer',
          userId: stateManager.get('userId'),
          targetId: stateManager.get('partnerId'),
          offer: peerConnection.localDescription
        });
      })
      .catch(e => console.error('Offer creation failed:', e));
  }
}

function handleOffer(data) {
  console.log('Received offer');
  if (!peerConnection) startWebRTC();

  stateManager.set('partnerId', data.from);

  peerConnection.setRemoteDescription(data.offer)
    .then(() => {
      console.log('Processing buffered ICE candidates');
      iceCandidatesBuffer.forEach(candidate => peerConnection.addIceCandidate(candidate));
      iceCandidatesBuffer = [];
      return peerConnection.createAnswer();
    })
    .then(answer => peerConnection.setLocalDescription(answer))
    .then(() => {
      console.log('Sending answer...');
      wsManager.send({
        type: 'answer',
        userId: stateManager.get('userId'),
        targetId: stateManager.get('partnerId'),
        answer: peerConnection.localDescription
      });
    })
    .catch(e => console.error('Error in handleOffer:', e));
}

function handleAnswer(data) {
  console.log('Received answer');
  peerConnection.setRemoteDescription(data.answer)
    .catch(e => console.error('Error in handleAnswer:', e));
}

function handleIceCandidate(data) {
  console.log('Received ICE candidate');
  const candidate = new RTCIceCandidate(data.candidate);

  if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
    peerConnection.addIceCandidate(candidate).catch(e => console.error('Error adding ICE candidate:', e));
  } else {
    console.log('Buffering ICE candidate');
    iceCandidatesBuffer.push(candidate);
  }
}

function handlePartnerDisconnect() {
  console.log('Partner disconnected');
  const mode = stateManager.get('currentMode');
  const statusElement = mode === 'video' ? elements.videoStatus : elements.textStatus;
  updateStatus(statusElement, 'Partner disconnected. Waiting for new partner...');

  if (mode === 'video') {
    if (peerConnection) {
      // Remove event handlers before closing
      peerConnection.onicecandidate = null;
      peerConnection.ontrack = null;
      peerConnection.onconnectionstatechange = null;
      peerConnection.oniceconnectionstatechange = null;

      peerConnection.close();
      peerConnection = null;
    }
    elements.remoteVideo.srcObject = null;
    stateManager.setMultiple({
      partnerId: null,
      partnerConnected: false
    });
    iceCandidatesBuffer = [];
    toggleVideoSpinner(true);
  } else {
    elements.messageInput.disabled = true;
    elements.sendBtn.disabled = true;
    stateManager.setMultiple({
      partnerId: null,
      partnerConnected: false
    });
  }
}

// ===== Video Request Functions =====

function sendVideoRequest() {
  const partnerId = stateManager.get('partnerId');
  if (!partnerId || videoRequestPending || stateManager.get('currentMode') !== 'text') return;

  videoRequestPending = true;
  elements.videoRequestBtn.classList.add('pending');
  elements.videoRequestBtn.innerHTML = '<span class="btn-icon">⏳</span> Request Sent...';
  elements.videoRequestBtn.disabled = true;

  wsManager.send({
    type: 'video-request',
    to: partnerId,
    from: stateManager.get('userId')
  });

  setTimeout(() => {
    if (videoRequestPending) {
      elements.videoRequestBtn.innerHTML = '<span class="btn-icon">✕</span> Cancel Request';
      elements.videoRequestBtn.disabled = false;
      elements.videoRequestBtn.onclick = cancelVideoRequest;
    }
  }, 500);
}

function cancelVideoRequest() {
  videoRequestPending = false;
  elements.videoRequestBtn.classList.remove('pending');
  elements.videoRequestBtn.innerHTML = '<span class="btn-icon">📹</span> Request Video';
  elements.videoRequestBtn.onclick = sendVideoRequest;

  wsManager.send({
    type: 'video-request-cancel',
    to: stateManager.get('partnerId'),
    from: stateManager.get('userId')
  });
}

function receiveVideoRequest(data) {
  console.log('📹 Received video request from:', data.from);

  elements.requestModalTitle.textContent = '📹 Video Chat Request';
  elements.requestModalMessage.textContent = 'Your partner wants to switch to video chat. Do you accept?';
  elements.videoRequestModal.style.display = 'flex';

  if (!stateManager.get('isMuted')) {
    playNotificationSound();
  }
}

function acceptVideoRequest() {
  elements.videoRequestModal.style.display = 'none';

  wsManager.send({
    type: 'video-request-accept',
    to: stateManager.get('partnerId'),
    from: stateManager.get('userId')
  });

  displaySystemMessage('Switching to video...');
  setTimeout(() => {
    switchToVideoMode();
  }, 500);
}

function declineVideoRequest() {
  elements.videoRequestModal.style.display = 'none';

  wsManager.send({
    type: 'video-request-decline',
    to: stateManager.get('partnerId'),
    from: stateManager.get('userId')
  });

  displaySystemMessage('You declined the video chat request.');
}

function handleVideoRequestAccepted() {
  videoRequestPending = false;
  elements.videoRequestBtn.classList.remove('pending');

  displaySystemMessage('Partner accepted! Switching to video...');

  setTimeout(() => {
    switchToVideoMode();
  }, 1000);
}

function handleVideoRequestDeclined() {
  videoRequestPending = false;
  elements.videoRequestBtn.classList.remove('pending');
  elements.videoRequestBtn.innerHTML = '<span class="btn-icon">📹</span> Request Video';
  elements.videoRequestBtn.disabled = false;
  elements.videoRequestBtn.onclick = sendVideoRequest;

  displaySystemMessage('Partner declined the video chat request.');
}

async function switchToVideoMode() {
  try {
    console.log('Switching to video mode...');

    const originalPartnerId = stateManager.get('partnerId');
    if (!originalPartnerId) {
      throw new Error('No partner connected');
    }

    stateManager.set('currentMode', 'video');

    elements.textChatView.style.display = 'none';
    elements.videoChatView.style.display = 'block';

    toggleVideoSpinner(true);
    elements.videoStatus.textContent = 'Setting up video...';

    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    elements.localVideo.srcObject = localStream;
    elements.localVideo.muted = true;

    elements.videoStatus.textContent = 'Connecting to partner...';

    wsManager.send({
      type: 'mode-switch-to-video',
      userId: stateManager.get('userId'),
      partnerId: originalPartnerId
    });

    elements.nextBtn.disabled = false;
    elements.reportBtn.disabled = false;

  } catch (error) {
    console.error('Failed to switch to video:', error);

    let errorMsg = 'Failed to access camera/microphone.';
    if (error.message === 'No partner connected') {
      errorMsg = 'Partner disconnected. Cannot switch to video.';
    } else if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      errorMsg = 'Camera/microphone permission denied.';
    } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
      errorMsg = 'No camera or microphone found.';
    } else if (error.name === 'NotReadableError') {
      errorMsg = 'Camera/microphone is already in use.';
    }

    displaySystemMessage(errorMsg);

    stateManager.set('currentMode', 'text');
    elements.textChatView.style.display = 'block';
    elements.videoChatView.style.display = 'none';
    toggleVideoSpinner(false);

    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }
  }
}

function handleVideoModeReady(data) {
  console.log('Video mode ready:', data);

  const currentPartnerId = stateManager.get('partnerId');
  if (currentPartnerId && data.partnerId !== currentPartnerId) {
    console.error(`Partner mismatch! Expected: ${currentPartnerId}, Got: ${data.partnerId}`);
    updateStatus(elements.videoStatus, 'Partner mismatch detected. Returning to text chat...', true);

    setTimeout(() => {
      stateManager.set('currentMode', 'text');
      elements.textChatView.style.display = 'block';
      elements.videoChatView.style.display = 'none';
      toggleVideoSpinner(false);

      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
      }
    }, 2000);
    return;
  }

  console.log(`Partner verified: ${data.partnerId}, isOfferer: ${data.isOfferer}`);

  isOfferer = data.isOfferer;
  stateManager.set('partnerId', data.partnerId);

  elements.videoStatus.textContent = 'Establishing video connection...';
  startWebRTC();
}

// ===== Initialization =====

document.addEventListener('DOMContentLoaded', () => {
  console.log('🚀 VibeConnect initialized');

  // Connect to WebSocket
  wsManager.connect();

  console.log('✨ Application ready');
});