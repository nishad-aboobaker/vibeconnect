// Generate random user ID
const userId = Math.random().toString(36).substring(2, 15);

// Security: Generate browser fingerprint
function generateFingerprint() {
  const data = [
    navigator.userAgent,
    navigator.language,
    screen.width + 'x' + screen.height,
    screen.colorDepth,
    new Date().getTimezoneOffset(),
    navigator.hardwareConcurrency || 0,
    navigator.platform
  ].join('|');

  // Simple hash function
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

const fingerprint = generateFingerprint();

// WebSocket connection - automatically detect environment
const getWebSocketUrl = () => {
  // Check if we're in production (deployed)
  if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    return 'wss://vibeconnect-4crg.onrender.com/'; // Deployed WebSocket server
  }
  // Local development
  return 'ws://localhost:3000';
};

let ws = new WebSocket(getWebSocketUrl());

// DOM elements
const landingView = document.getElementById('landingView');
const textChatView = document.getElementById('textChatView');
const videoChatView = document.getElementById('videoChatView');
const textChatBtn = document.getElementById("textChatBtn");
const videoChatBtn = document.getElementById("videoChatBtn");
const messageContainer = document.getElementById("messageContainer");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const textStatus = document.getElementById("textStatus");
const textBackBtn = document.getElementById("textBackBtn");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const videoStatus = document.getElementById("status");
const videoBackBtn = document.getElementById("videoBackBtn");
const videoSpinner = document.getElementById("videoSpinner");
const textNextBtn = document.getElementById("textNextBtn");
const textReportBtn = document.getElementById("textReportBtn");
const nextBtn = document.getElementById("nextBtn");
const reportBtn = document.getElementById("reportBtn");
const userCount = document.getElementById("userCount");
const muteBtn = document.getElementById("muteBtn");
const typingIndicator = document.getElementById("typingIndicator");
const termsModal = document.getElementById("termsModal");
const termsCancelBtn = document.getElementById("termsCancelBtn");
const termsAgreeBtn = document.getElementById("termsAgreeBtn");
const termsCheckbox = document.getElementById("termsCheckbox");
const connectionStatus = document.getElementById("connectionStatus");
const videoRequestBtn = document.getElementById("videoRequestBtn");
const videoRequestModal = document.getElementById("videoRequestModal");
const requestModalTitle = document.getElementById("requestModalTitle");
const requestModalMessage = document.getElementById("requestModalMessage");
const acceptVideoBtn = document.getElementById("acceptVideoBtn");
const declineVideoBtn = document.getElementById("declineVideoBtn");


// WebRTC variables
let localStream;
let peerConnection;
let partnerId;
let isOfferer = false;
let iceCandidatesBuffer = [];
let currentMode = null;
let pendingMode = null;
let connectionTimeout = null; // Track WebRTC connection timeout

// WebRTC configuration
const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// Feature state
let isMuted = localStorage.getItem('isMuted') === 'true';
let typingTimeout = null;
let videoRequestPending = false;
let videoRequestReceived = false;


// ===== Helper Functions =====
function sendWsMessage(payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  } else {
    console.error("WebSocket is not open. Cannot send message:", payload);
    // Optionally, display an error to the user
    const statusElement = currentMode === 'video' ? videoStatus : textStatus;
    if (statusElement) {
      statusElement.textContent = 'Connection lost. Please try reconnecting.';
    }
  }
}

// ===== Event Listeners =====
textChatBtn.addEventListener("click", () => showTermsModal("text"));
videoChatBtn.addEventListener("click", () => showTermsModal("video"));
termsCancelBtn.addEventListener("click", hideTermsModal);
termsAgreeBtn.addEventListener("click", handleTermsAgree);
sendBtn.addEventListener("click", sendMessage);
messageInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter" && !sendBtn.disabled) sendMessage();
});
textBackBtn.addEventListener("click", returnToLanding);
videoBackBtn.addEventListener("click", returnToLanding);
textNextBtn.addEventListener("click", skipPartner);
textReportBtn.addEventListener("click", reportUser);
nextBtn.addEventListener("click", skipPartner);
reportBtn.addEventListener("click", reportUser);
muteBtn.addEventListener("click", toggleMute);
messageInput.addEventListener("input", handleTyping);

// Terms checkbox handler
termsCheckbox.addEventListener("change", () => {
  termsAgreeBtn.disabled = !termsCheckbox.checked;
});

// Video request handlers
videoRequestBtn.addEventListener("click", sendVideoRequest);
acceptVideoBtn.addEventListener("click", acceptVideoRequest);
declineVideoBtn.addEventListener("click", declineVideoRequest);


// ===== WebSocket Connection =====
function connectWebSocket() {
  console.log('Connecting to WebSocket...');
  updateConnectionStatus('Connecting...', 'connecting');
  textChatBtn.disabled = true;
  videoChatBtn.disabled = true;

  ws = new WebSocket(getWebSocketUrl());

  ws.onopen = () => {
    console.log("Connected to server");
    updateConnectionStatus('Connected', 'connected');
    textChatBtn.disabled = false;
    videoChatBtn.disabled = false;

    sendWsMessage({ type: "identify", userId, fingerprint });

    // Update user count status
    if (userCount) {
      userCount.textContent = "🟢 Connecting...";
    }
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log("Received:", data);

    switch (data.type) {
      case "waiting":
        updateStatus(currentMode === 'video' ? videoStatus : textStatus, "Waiting for a partner...");
        break;
      case "paired":
        partnerId = data.partnerId;
        playNotificationSound();
        if (currentMode === "text") {
          updateStatus(textStatus, "Connected! You can now chat.");
          messageInput.disabled = false;
          sendBtn.disabled = false;
          textNextBtn.disabled = false;
          textReportBtn.disabled = false;
          videoRequestBtn.disabled = false; // Enable video request
          messageInput.focus();
        } else if (currentMode === "video") {
          isOfferer = data.isOfferer;
          updateStatus(videoStatus, "Connected! Starting video...");
          nextBtn.disabled = false;
          reportBtn.disabled = false;
          startWebRTC();
        }
        break;
      case "text-message":
        handleTextMessage(data);
        break;
      case "offer":
        handleOffer(data);
        break;
      case "answer":
        handleAnswer(data);
        break;
      case "ice-candidate":
        handleIceCandidate(data);
        break;
      case "partner-disconnected":
        handlePartnerDisconnect();
        break;
      case "user-count":
        console.log("Received user count:", data.count);
        try {
          if (userCount) {
            userCount.textContent = `🟢 ${data.count !== undefined ? data.count : '?'} users online`;
          } else {
            console.error("userCount element not found in DOM");
          }
        } catch (e) {
          console.error("Error updating user count:", e);
        }
        break;
      case "typing-start":
        if (currentMode === "text") typingIndicator.style.display = "block";
        break;
      case "typing-stop":
        if (currentMode === "text") typingIndicator.style.display = "none";
        break;
      case "error":
        handleServerError(data.message);
        break;
      case "video-request":
        receiveVideoRequest(data);
        break;
      case "video-request-accept":
        handleVideoRequestAccepted();
        break;
      case "video-request-decline":
        handleVideoRequestDeclined();
        break;
      case "video-request-cancel":
        // Partner cancelled their request
        videoRequestModal.style.display = "none";
        videoRequestReceived = false;
        displaySystemMessage("Partner cancelled the video request.");
        break;
      case "video-mode-ready":
        handleVideoModeReady(data);
        break;
      case "warning":
        console.warn("Server warning:", data.message);
        alert(`⚠️ Warning: ${data.message}`);
        break;
    }
  };

  ws.onclose = () => {
    console.log("Disconnected from server");
    updateConnectionStatus('Disconnected', 'disconnected');
    textChatBtn.disabled = true;
    videoChatBtn.disabled = true;

    if (currentMode) {
      const statusElement = currentMode === 'video' ? videoStatus : textStatus;
      updateStatus(statusElement, "Connection lost. Please return to the main menu.", true);
      if (currentMode === 'video') stopVideoChat(false); // Don't send another disconnect message
      else if (currentMode === 'text') stopTextChat(false); // Don't send another disconnect message
    }

    // Attempt to reconnect after a delay
    setTimeout(connectWebSocket, 5000);
  };

  ws.onerror = (error) => {
    console.error('WebSocket Error:', error);
    updateConnectionStatus('Error', 'error');
    // ws.close() will be called automatically, triggering onclose
  };
}

function updateConnectionStatus(text, statusClass) {
  connectionStatus.textContent = text;
  connectionStatus.className = 'connection-status'; // Reset classes
  connectionStatus.classList.add(statusClass);
}



// ===== View Management =====
function showTextChatView() {
  landingView.style.display = "none";
  textChatView.style.display = "block";
  currentMode = "text";
  document.body.classList.add('chat-active');
}

function showVideoChatView() {
  landingView.style.display = "none";
  videoChatView.style.display = "block";
  currentMode = "video";
}

function showLandingView() {
  landingView.style.display = "block";
  textChatView.style.display = "none";
  videoChatView.style.display = "none";
  currentMode = null;
  document.body.classList.remove('chat-active');
}

function showTermsModal(mode) {
  pendingMode = mode;
  termsModal.style.display = "flex";
}

function hideTermsModal() {
  termsModal.style.display = "none";
  pendingMode = null;
}

function handleTermsAgree() {
  if (pendingMode === "text") {
    showTextChatView();
    startTextChat();
  } else if (pendingMode === "video") {
    showVideoChatView();
    startVideoChat();
  }
  hideTermsModal();
}

function returnToLanding() {
  if (currentMode === "text") {
    stopTextChat();
  } else if (currentMode === "video") {
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

function handleServerError(message) {
  console.error("Server error:", message);
  const statusElement = currentMode === 'video' ? videoStatus : textStatus;
  updateStatus(statusElement, `Error: ${message}`, true);
  setTimeout(() => updateStatus(statusElement, ' '), 3000);
}


// ===== Feature Functions =====
function skipPartner() {
  console.log("Skipping to next partner...");
  const statusElement = currentMode === 'video' ? videoStatus : textStatus;
  updateStatus(statusElement, "Skipping... Finding new partner...");
  if (currentMode === 'video') {
    nextBtn.disabled = true;
    reportBtn.disabled = true;
    toggleVideoSpinner(true);
  } else {
    textNextBtn.disabled = true;
    textReportBtn.disabled = true;
  }

  if (partnerId) {
    sendWsMessage({ type: "disconnect", userId });
    partnerId = null;
  }

  setTimeout(() => {
    if (currentMode === "text") {
      messageContainer.innerHTML = "";
      sendWsMessage({ type: "join-text", userId });
    } else if (currentMode === "video") {
      sendWsMessage({ type: "join-video", userId });
    }
  }, 300);
}

function reportUser() {
  if (!partnerId) return;
  const reason = prompt("Report reason:\n1. Inappropriate\n2. Spam\n3. Harassment\n4. Other");
  if (reason) {
    const reportReason = ["inappropriate", "spam", "harassment", "other"][parseInt(reason) - 1] || "other";
    sendWsMessage({ type: "report-user", userId, reportedId: partnerId, reason: reportReason });
    console.log("User reported:", reportReason);
    updateStatus(currentMode === 'video' ? videoStatus : textStatus, "User reported. Disconnecting...", true);
    setTimeout(() => {
      if (currentMode === 'text') stopTextChat();
      else if (currentMode === 'video') stopVideoChat();
    }, 1500);
  }
}

function handleTyping() {
  if (!partnerId || currentMode !== "text") return;
  sendWsMessage({ type: "typing-start", userId, targetId: partnerId });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    sendWsMessage({ type: "typing-stop", userId, targetId: partnerId });
  }, 2000);
}

function playNotificationSound() {
  if (isMuted) return;
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
    console.error("Could not play notification sound", e);
  }
}

function toggleMute() {
  isMuted = !isMuted;
  localStorage.setItem('isMuted', isMuted);
  updateMuteButton();
}

function updateMuteButton() {
  muteBtn.textContent = isMuted ? '🔇' : '🔊';
  muteBtn.classList.toggle('muted', isMuted);
}

// ===== Text Chat Functions =====
function startTextChat() {
  console.log("Starting text chat...");
  messageContainer.innerHTML = "";
  sendWsMessage({ type: "join-text", userId });
  updateStatus(textStatus, "Joining chat...");
}

function stopTextChat(notifyServer = true) {
  console.log("Stopping text chat...");
  if (notifyServer) sendWsMessage({ type: "disconnect", userId });
  messageInput.disabled = true;
  sendBtn.disabled = true;
  messageInput.value = "";
  updateStatus(textStatus, "Chat stopped. Go back to start again.");
  partnerId = null;
  textNextBtn.disabled = true;
  textReportBtn.disabled = true;
  typingIndicator.style.display = "none";
}

function sendMessage() {
  const message = messageInput.value.trim();
  if (!message || !partnerId) return;
  displayMessage(message, true);
  sendWsMessage({ type: "text-message", userId, targetId: partnerId, message });
  messageInput.value = "";
  messageInput.focus();
}

function handleTextMessage(data) {
  displayMessage(data.message, false);
}

function displayMessage(message, isSent) {
  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${isSent ? "sent" : "received"}`;
  messageDiv.textContent = message; // Prevents XSS
  messageContainer.appendChild(messageDiv);
  messageContainer.scrollTop = messageContainer.scrollHeight;
}

// ===== Video Chat Functions =====
function toggleVideoSpinner(show) {
  videoSpinner.style.display = show ? "flex" : "none";
}

async function startVideoChat() {
  console.log("Requesting user media...");
  toggleVideoSpinner(true);
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    console.log("Got local stream");
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    sendWsMessage({ type: "join-video", userId });
    updateStatus(videoStatus, "Joining chat...");
  } catch (error) {
    console.error("Error accessing media devices:", error);
    let msg = "Error: Could not access camera/microphone.";
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      msg = "Error: Camera/microphone permission denied.";
    } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      msg = "Error: No camera or microphone found.";
    } else if (error.name === "NotReadableError") {
      msg = "Error: Camera/microphone is already in use.";
    }
    updateStatus(videoStatus, msg, true);
    toggleVideoSpinner(false);
  }
}

function stopVideoChat(notifyServer = true) {
  console.log("Stopping video chat...");
  if (notifyServer) sendWsMessage({ type: "disconnect", userId });
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  updateStatus(videoStatus, 'Chat stopped. Go back to start again.');
  partnerId = null;
  isOfferer = false;
  iceCandidatesBuffer = [];
  toggleVideoSpinner(false);
  nextBtn.disabled = true;
  reportBtn.disabled = true;
}

function startWebRTC() {
  console.log("Starting WebRTC connection...");
  peerConnection = new RTCPeerConnection(rtcConfig);
  if (localStream) {
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  }
  peerConnection.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.onplaying = () => {
        updateStatus(videoStatus, "Video chat active!");
        toggleVideoSpinner(false);
      };
      updateStatus(videoStatus, "Connecting video...");
    } else {
      updateStatus(videoStatus, "No video stream from partner.");
    }
  };
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendWsMessage({ type: "ice-candidate", userId, targetId: partnerId, candidate: event.candidate });
    }
  };
  peerConnection.onconnectionstatechange = () => {
    console.log(`Peer connection state: ${peerConnection.connectionState}`);

    if (peerConnection.connectionState === "connected") {
      // Clear timeout on successful connection
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }
      updateStatus(videoStatus, "Video chat active!");
      toggleVideoSpinner(false);
    } else if (peerConnection.connectionState === "connecting") {
      updateStatus(videoStatus, "Connecting video...");
    } else if (peerConnection.connectionState === "failed") {
      // Clear timeout
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }
      updateStatus(videoStatus, "Connection failed. Please try again.", true);
      toggleVideoSpinner(false);
    } else if (peerConnection.connectionState === 'disconnected') {
      // Clear timeout
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }
      handlePartnerDisconnect();
    }
  };

  // Set 15-second timeout for connection
  connectionTimeout = setTimeout(() => {
    if (peerConnection && peerConnection.connectionState !== 'connected') {
      console.error("WebRTC connection timeout");
      updateStatus(videoStatus, "Connection timeout. Please try again.", true);
      toggleVideoSpinner(false);

      // Close peer connection
      if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
      }

      // Enable retry
      nextBtn.disabled = false;
      reportBtn.disabled = false;
    }
  }, 15000);
  if (isOfferer) {
    peerConnection.createOffer()
      .then(offer => peerConnection.setLocalDescription(offer))
      .then(() => sendWsMessage({ type: "offer", userId, targetId: partnerId, offer: peerConnection.localDescription }))
      .catch(e => console.error("Offer creation failed:", e));
  } else {
    console.log("Waiting for offer...");
  }
}

function handleOffer(data) {
  console.log("Received offer");
  if (!peerConnection) startWebRTC();
  partnerId = data.from;
  peerConnection.setRemoteDescription(data.offer)
    .then(() => {
      console.log("Processing buffered ICE candidates");
      iceCandidatesBuffer.forEach(candidate => peerConnection.addIceCandidate(candidate));
      iceCandidatesBuffer = [];
      return peerConnection.createAnswer();
    })
    .then(answer => peerConnection.setLocalDescription(answer))
    .then(() => sendWsMessage({ type: "answer", userId, targetId: partnerId, answer: peerConnection.localDescription }))
    .catch(e => console.error("Error in handleOffer:", e));
}

function handleAnswer(data) {
  console.log("Received answer");
  peerConnection.setRemoteDescription(data.answer)
    .catch(e => console.error("Error in handleAnswer:", e));
}

function handleIceCandidate(data) {
  console.log("Received ICE candidate");
  const candidate = new RTCIceCandidate(data.candidate);
  if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
    peerConnection.addIceCandidate(candidate).catch(e => console.error("Error adding ICE candidate:", e));
  } else {
    console.log("Buffering ICE candidate");
    iceCandidatesBuffer.push(candidate);
  }
}

function handlePartnerDisconnect() {
  console.log("Partner disconnected");
  const statusElement = currentMode === 'video' ? videoStatus : textStatus;
  updateStatus(statusElement, "Partner disconnected. Waiting for new partner...");
  if (currentMode === "video") {
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    remoteVideo.srcObject = null;
    partnerId = null;
    iceCandidatesBuffer = [];
    toggleVideoSpinner(true); // Show spinner while waiting
    // The server should automatically requeue us, no need to send join-video again unless specified by server logic.
  } else {
    messageInput.disabled = true;
    sendBtn.disabled = true;
    partnerId = null;
  }
}

// ===== Video Request Functions =====
function sendVideoRequest() {
  if (!partnerId || videoRequestPending || currentMode !== "text") return;

  videoRequestPending = true;
  videoRequestBtn.classList.add("pending");
  videoRequestBtn.innerHTML = '<span class="btn-icon">⏳</span> Request Sent...';
  videoRequestBtn.disabled = true;

  sendWsMessage({
    type: "video-request",
    to: partnerId,
    from: userId
  });

  // Show cancel option after a moment
  setTimeout(() => {
    if (videoRequestPending) {
      videoRequestBtn.innerHTML = '<span class="btn-icon">✕</span> Cancel Request';
      videoRequestBtn.disabled = false;
      videoRequestBtn.onclick = cancelVideoRequest;
    }
  }, 500);
}

function cancelVideoRequest() {
  videoRequestPending = false;
  videoRequestBtn.classList.remove("pending");
  videoRequestBtn.innerHTML = '<span class="btn-icon">📹</span> Request Video';
  videoRequestBtn.onclick = sendVideoRequest;

  sendWsMessage({
    type: "video-request-cancel",
    to: partnerId,
    from: userId
  });
}

function receiveVideoRequest(data) {
  console.log("📹 Received video request from:", data.from);
  videoRequestReceived = true;

  // Show modal
  requestModalTitle.textContent = "📹 Video Chat Request";
  requestModalMessage.textContent = "Your partner wants to switch to video chat. Do you accept?";
  videoRequestModal.style.display = "flex";

  // Play notification sound if not muted
  if (!isMuted) {
    playNotificationSound();
  }
}

function acceptVideoRequest() {
  videoRequestModal.style.display = "none";
  videoRequestReceived = false;

  sendWsMessage({
    type: "video-request-accept",
    to: partnerId,
    from: userId
  });

  // Switch to video mode
  displaySystemMessage("Switching to video...");
  setTimeout(() => {
    switchToVideoMode();
  }, 500);
}

function declineVideoRequest() {
  videoRequestModal.style.display = "none";
  videoRequestReceived = false;

  sendWsMessage({
    type: "video-request-decline",
    to: partnerId,
    from: userId
  });

  // Show message in chat
  displaySystemMessage("You declined the video chat request.");
}

function handleVideoRequestAccepted() {
  videoRequestPending = false;
  videoRequestBtn.classList.remove("pending");

  // Show success message
  displaySystemMessage("Partner accepted! Switching to video...");

  // Switch to video mode after 1 second
  setTimeout(() => {
    switchToVideoMode();
  }, 1000);
}

function handleVideoRequestDeclined() {
  videoRequestPending = false;
  videoRequestBtn.classList.remove("pending");
  videoRequestBtn.innerHTML = '<span class="btn-icon">📹</span> Request Video';
  videoRequestBtn.disabled = false;
  videoRequestBtn.onclick = sendVideoRequest;

  // Show message in chat
  displaySystemMessage("Partner declined the video chat request.");
}

async function switchToVideoMode() {
  try {
    console.log("Switching to video mode...");

    // CRITICAL: Store original partner ID to ensure same partner after switch
    const originalPartnerId = partnerId;

    // Validate partner is still connected
    if (!originalPartnerId) {
      throw new Error("No partner connected");
    }

    console.log(`Preserving partner ID: ${originalPartnerId}`);

    // Update current mode BEFORE getting media
    currentMode = "video";

    // Hide text chat, show video chat
    textChatView.style.display = "none";
    videoChatView.style.display = "block";

    // Show spinner while setting up
    toggleVideoSpinner(true);
    videoStatus.textContent = "Setting up video...";

    // Get camera/mic permissions
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    // Set local video
    localVideo.srcObject = localStream;
    localVideo.muted = true;

    // Update status
    videoStatus.textContent = "Connecting to partner...";

    // Notify server about mode switch - server will coordinate who is offerer
    sendWsMessage({
      type: "mode-switch-to-video",
      userId: userId,
      partnerId: originalPartnerId  // Use preserved partner ID
    });

    // Enable video controls
    nextBtn.disabled = false;
    reportBtn.disabled = false;

  } catch (error) {
    console.error("Failed to switch to video:", error);

    let errorMsg = "Failed to access camera/microphone.";
    if (error.message === "No partner connected") {
      errorMsg = "Partner disconnected. Cannot switch to video.";
    } else if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      errorMsg = "Camera/microphone permission denied.";
    } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      errorMsg = "No camera or microphone found.";
    } else if (error.name === "NotReadableError") {
      errorMsg = "Camera/microphone is already in use.";
    }

    displaySystemMessage(errorMsg);

    // Revert to text chat
    currentMode = "text";
    textChatView.style.display = "block";
    videoChatView.style.display = "none";
    toggleVideoSpinner(false);

    // Stop any tracks that might have been started
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }
  }
}

function displaySystemMessage(message) {
  const systemMsg = document.createElement("div");
  systemMsg.className = "message system-message";
  systemMsg.textContent = message;
  messageContainer.appendChild(systemMsg);
  messageContainer.scrollTop = messageContainer.scrollHeight;
}

function handleVideoModeReady(data) {
  console.log("Video mode ready:", data);

  // CRITICAL: Validate partner ID matches to prevent connecting to wrong user
  if (partnerId && data.partnerId !== partnerId) {
    console.error(`Partner mismatch! Expected: ${partnerId}, Got: ${data.partnerId}`);
    updateStatus(videoStatus, "Partner mismatch detected. Returning to text chat...", true);

    // Revert to text chat
    setTimeout(() => {
      currentMode = "text";
      textChatView.style.display = "block";
      videoChatView.style.display = "none";
      toggleVideoSpinner(false);

      // Stop media tracks
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
      }
    }, 2000);
    return;
  }

  console.log(`Partner verified: ${data.partnerId}, isOfferer: ${data.isOfferer}`);

  isOfferer = data.isOfferer;
  partnerId = data.partnerId;

  // Now that both users are ready and we know who is offerer, start WebRTC
  videoStatus.textContent = "Establishing video connection...";
  startWebRTC();
}

// Initial setup
document.addEventListener('DOMContentLoaded', () => {
  updateMuteButton();
  connectWebSocket();
});