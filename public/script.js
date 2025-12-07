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
    // Use environment variable or default WebSocket server URL
    // You need to set this to your deployed WebSocket server URL
    return 'wss://vibeconnect-4crg.onrender.com/'; // REPLACE THIS with your WebSocket server URL
  }
  // Local development
  return 'ws://localhost:3000';
};

const ws = new WebSocket(getWebSocketUrl());
const textChatBtn = document.getElementById("textChatBtn");
const videoChatBtn = document.getElementById("videoChatBtn");

// DOM elements - Text Chat
const messageContainer = document.getElementById("messageContainer");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
// const textStartBtn = document.getElementById("textStartBtn"); // Removed
// const textStopBtn = document.getElementById("textStopBtn"); // Removed
const textStatus = document.getElementById("textStatus");
const textBackBtn = document.getElementById("textBackBtn");

// DOM elements - Video Chat
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
// const startBtn = document.getElementById("startBtn"); // Removed
// const stopBtn = document.getElementById("stopBtn"); // Removed
const videoStatus = document.getElementById("status");
const videoBackBtn = document.getElementById("videoBackBtn");

// New feature elements
const textNextBtn = document.getElementById("textNextBtn");
const textReportBtn = document.getElementById("textReportBtn");
const nextBtn = document.getElementById("nextBtn");
const reportBtn = document.getElementById("reportBtn");
const userCount = document.getElementById("userCount");
const muteBtn = document.getElementById("muteBtn");
const typingIndicator = document.getElementById("typingIndicator");
const termsCancelBtn = document.getElementById("termsCancelBtn");
const termsAgreeBtn = document.getElementById("termsAgreeBtn");

// WebRTC variables
let localStream;
let peerConnection;
let partnerId;
let isOfferer = false;
let iceCandidatesBuffer = [];

// WebRTC configuration
const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// Feature state
let isMuted = localStorage.getItem('isMuted') === 'true';
let typingTimeout = null;

// ===== Event Listeners =====
// Landing page
// Landing page
textChatBtn.addEventListener("click", () => showTermsModal("text"));
videoChatBtn.addEventListener("click", () => showTermsModal("video"));

// Terms Modal
termsCancelBtn.addEventListener("click", hideTermsModal);
termsAgreeBtn.addEventListener("click", handleTermsAgree);

// Text chat
// textStartBtn.addEventListener("click", startTextChat); // Removed
// textStopBtn.addEventListener("click", stopTextChat); // Removed
sendBtn.addEventListener("click", sendMessage);
messageInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter" && !sendBtn.disabled) {
    sendMessage();
  }
});
textBackBtn.addEventListener("click", returnToLanding);

// Video chat
// startBtn.addEventListener("click", startVideoChat); // Removed
// stopBtn.addEventListener("click", stopVideoChat); // Removed
videoBackBtn.addEventListener("click", returnToLanding);

// New feature listeners
textNextBtn.addEventListener("click", skipPartner);
textReportBtn.addEventListener("click", reportUser);
nextBtn.addEventListener("click", skipPartner);
reportBtn.addEventListener("click", reportUser);
muteBtn.addEventListener("click", toggleMute);
messageInput.addEventListener("input", handleTyping);

// Initialize mute state
updateMuteButton();

// ===== WebSocket Event Handlers =====
ws.onopen = () => {
  console.log("Connected to server");

  // Security: Send fingerprint for tracking
  ws.send(JSON.stringify({
    type: "identify",
    userId,
    fingerprint
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log("Received:", data);

  switch (data.type) {
    case "waiting":
      if (currentMode === "text") {
        textStatus.textContent = "Waiting for a partner...";
      } else if (currentMode === "video") {
        videoStatus.textContent = "Waiting for a partner...";
      }
      break;
    case "paired":
      partnerId = data.partnerId;

      // Play notification sound
      playNotificationSound();

      if (currentMode === "text") {
        textStatus.textContent = "Connected! You can now chat.";
        messageInput.disabled = false;
        sendBtn.disabled = false;
        messageInput.focus();
        // Enable Next and Report buttons
        textNextBtn.disabled = false;
        textReportBtn.disabled = false;
      } else if (currentMode === "video") {
        isOfferer = data.isOfferer;
        videoStatus.textContent = "Connected! Starting video...";
        // Enable Next and Report buttons
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
      userCount.textContent = `🟢 ${data.count} users online`;
      break;
    case "typing-start":
      if (currentMode === "text") {
        typingIndicator.style.display = "flex";
      }
      break;
    case "typing-stop":
      if (currentMode === "text") {
        typingIndicator.style.display = "none";
      }
      break;
    case "error":
      // Security: Handle error messages from server
      console.error("Server error:", data.message);
      if (currentMode === "text") {
        textStatus.textContent = `Error: ${data.message}`;
        textStatus.style.color = "#ff6b6b";
        setTimeout(() => {
          textStatus.style.color = "";
        }, 3000);
      } else if (currentMode === "video") {
        videoStatus.textContent = `Error: ${data.message}`;
        videoStatus.style.color = "#ff6b6b";
        setTimeout(() => {
          videoStatus.style.color = "";
        }, 3000);
      }
      break;
    case "warning":
      // Security: Handle warning messages from server
      console.warn("Server warning:", data.message);
      alert(`⚠️ Warning: ${data.message}`);
      break;
  }
};

ws.onclose = () => {
  console.log("Disconnected from server");
  if (currentMode === "text") {
    stopTextChat();
  } else if (currentMode === "video") {
    stopVideoChat();
  }
};

// ===== View Management =====
function showTextChatView() {
  landingView.style.display = "none";
  textChatView.style.display = "block";
  videoChatView.style.display = "none";
  currentMode = "text";
  console.log("Switched to text chat view");
}

function showVideoChatView() {
  landingView.style.display = "none";
  textChatView.style.display = "none";
  videoChatView.style.display = "block";
  currentMode = "video";
  console.log("Switched to video chat view");
}

function showLandingView() {
  landingView.style.display = "block";
  textChatView.style.display = "none";
  videoChatView.style.display = "none";
  currentMode = null;
  console.log("Switched to landing view");
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
    startTextChat(); // Auto-start
  } else if (pendingMode === "video") {
    showVideoChatView();
    startVideoChat(); // Auto-start
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

// ===== New Feature Functions =====
function skipPartner() {
  console.log("Skipping to next partner...");

  // Update status immediately
  if (currentMode === "text") {
    textStatus.textContent = "Skipping... Finding new partner...";
    // Disable buttons to prevent double-clicks
    textNextBtn.disabled = true;
    textReportBtn.disabled = true;
  } else if (currentMode === "video") {
    videoStatus.textContent = "Skipping... Finding new partner...";
    nextBtn.disabled = true;
    reportBtn.disabled = true;
  }

  // Disconnect current partner
  if (partnerId) {
    ws.send(JSON.stringify({ type: "disconnect", userId }));
    partnerId = null;
  }

  // Small delay to ensure server processes disconnect before rejoin
  setTimeout(() => {
    if (currentMode === "text") {
      // Clear messages
      messageContainer.innerHTML = "";
      ws.send(JSON.stringify({ type: "join-text", userId }));
    } else if (currentMode === "video") {
      ws.send(JSON.stringify({ type: "join-video", userId }));
    }
  }, 300);
}

function reportUser() {
  if (!partnerId) return;

  const reason = prompt("Report reason:\n1. Inappropriate content\n2. Spam\n3. Harassment\n4. Other\n\nEnter number (1-4):");

  if (reason) {
    const reasons = ["inappropriate", "spam", "harassment", "other"];
    const reportReason = reasons[parseInt(reason) - 1] || "other";

    ws.send(JSON.stringify({
      type: "report-user",
      userId,
      reportedId: partnerId,
      reason: reportReason
    }));

    console.log("User reported:", reportReason);

    // Update UI to show reported status
    if (currentMode === "text") {
      textStatus.textContent = "User reported. Disconnecting...";
      textStatus.style.color = "#ff6b6b";
    } else if (currentMode === "video") {
      videoStatus.textContent = "User reported. Disconnecting...";
      videoStatus.style.color = "#ff6b6b";
    }

    // Disconnect after a short delay to allow user to see the message
    setTimeout(() => {
      if (currentMode === "text") {
        textStatus.style.color = ""; // Reset color
        stopTextChat();
      } else if (currentMode === "video") {
        videoStatus.style.color = ""; // Reset color
        stopVideoChat();
      }
    }, 1500);
  }
}

function handleTyping() {
  if (!partnerId || currentMode !== "text") return;

  // Send typing-start
  ws.send(JSON.stringify({
    type: "typing-start",
    userId,
    targetId: partnerId
  }));

  // Clear previous timeout
  clearTimeout(typingTimeout);

  // Send typing-stop after 2 seconds of no typing
  typingTimeout = setTimeout(() => {
    ws.send(JSON.stringify({
      type: "typing-stop",
      userId,
      targetId: partnerId
    }));
  }, 2000);
}

function playNotificationSound() {
  if (isMuted) return;

  // Create audio context and play beep
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

  // Clear previous messages
  messageContainer.innerHTML = "";

  // Send join message for text chat
  ws.send(JSON.stringify({ type: "join-text", userId }));

  // textStartBtn.disabled = true; // Removed
  // textStopBtn.disabled = false; // Removed
  textStatus.textContent = "Joining chat...";

  console.log("Sent join-text request");
}

function stopTextChat() {
  console.log("Stopping text chat...");

  // Send disconnect message
  ws.send(JSON.stringify({ type: "disconnect", userId }));

  // Reset UI
  messageInput.disabled = true;
  sendBtn.disabled = true;
  messageInput.value = "";
  // textStartBtn.disabled = false; // Removed
  // textStopBtn.disabled = true; // Removed
  textStatus.textContent = "Chat stopped. Go back to start again.";
  partnerId = null;

  // Disable feature buttons
  textNextBtn.disabled = true;
  textReportBtn.disabled = true;
  typingIndicator.style.display = "none";

  console.log("Text chat stopped");
}

function sendMessage() {
  const message = messageInput.value.trim();

  if (!message || !partnerId) {
    return;
  }

  console.log("Sending message:", message);

  // Display message locally
  displayMessage(message, true);

  // Send to partner
  ws.send(
    JSON.stringify({
      type: "text-message",
      userId,
      targetId: partnerId,
      message,
    })
  );

  // Clear input
  messageInput.value = "";
  messageInput.focus();
}

function handleTextMessage(data) {
  console.log("Received text message:", data.message);
  displayMessage(data.message, false);
}

function displayMessage(message, isSent) {
  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${isSent ? "sent" : "received"}`;

  // Security: Sanitize message to prevent XSS
  // Use textContent instead of innerHTML to prevent script execution
  messageDiv.textContent = message;

  messageContainer.appendChild(messageDiv);

  // Scroll to bottom
  messageContainer.scrollTop = messageContainer.scrollHeight;
}

// ===== Video Chat Functions =====
async function startVideoChat() {
  try {
    console.log("Requesting user media...");

    // Get user media
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });

    console.log("Got local stream:", localStream);
    console.log("Video tracks:", localStream.getVideoTracks());
    console.log("Audio tracks:", localStream.getAudioTracks());

    // Verify we have active tracks
    const videoTracks = localStream.getVideoTracks();
    const audioTracks = localStream.getAudioTracks();

    if (videoTracks.length === 0) {
      throw new Error("No video track available");
    }
    if (audioTracks.length === 0) {
      throw new Error("No audio track available");
    }

    console.log("Video track settings:", videoTracks[0].getSettings());

    // Set local video source
    localVideo.srcObject = localStream;

    // Wait for video metadata to load
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timeout waiting for video metadata"));
      }, 5000);

      localVideo.onloadedmetadata = () => {
        clearTimeout(timeout);
        console.log("Local video metadata loaded");
        console.log("Local video dimensions:", localVideo.videoWidth, "x", localVideo.videoHeight);
        resolve();
      };
    });

    // Send join message for video chat
    ws.send(JSON.stringify({ type: "join-video", userId }));

    // startBtn.disabled = true; // Removed
    // stopBtn.disabled = false; // Removed
    videoStatus.textContent = "Joining chat...";

    console.log("Successfully started video chat, waiting for partner...");
  } catch (error) {
    console.error("Error accessing media devices:", error);

    // Provide specific error messages
    let errorMessage = "Error: Could not access camera/microphone";
    if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
      errorMessage = "Error: Camera/microphone permission denied. Please allow access and try again.";
    } else if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      errorMessage = "Error: No camera or microphone found. Please connect devices and try again.";
    } else if (error.name === "NotReadableError" || error.name === "TrackStartError") {
      errorMessage = "Error: Camera/microphone is already in use by another application.";
    } else if (error.message) {
      errorMessage = `Error: ${error.message}`;
    }

    videoStatus.textContent = errorMessage;
  }
}

function stopVideoChat() {
  console.log("Stopping video chat...");

  // Stop all local stream tracks
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      track.stop();
      console.log("Stopped track:", track.kind);
    });
    localStream = null;
  }

  // Close peer connection
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
    console.log("Peer connection closed");
  }

  // Send disconnect message
  ws.send(JSON.stringify({ type: "disconnect", userId }));

  // Clear video sources
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;

  // Reset state
  // startBtn.disabled = false; // Removed
  // stopBtn.disabled = true; // Removed
  videoStatus.textContent = 'Chat stopped. Go back to start again.';
  partnerId = null;
  isOfferer = false;
  iceCandidatesBuffer = [];

  // Disable feature buttons
  nextBtn.disabled = true;
  reportBtn.disabled = true;

  console.log("Video chat stopped and cleaned up");
}

function startWebRTC() {
  console.log("Starting WebRTC connection...");
  peerConnection = new RTCPeerConnection(rtcConfig);

  // Add local stream
  localStream
    .getTracks()
    .forEach((track) => {
      peerConnection.addTrack(track, localStream);
      console.log("Added local track:", track.kind);
    });

  // Handle remote stream
  peerConnection.ontrack = (event) => {
    console.log("Received remote track:", event.track.kind);
    console.log("Remote streams:", event.streams);

    if (event.streams && event.streams[0]) {
      const remoteStream = event.streams[0];
      console.log("Remote stream tracks:", remoteStream.getTracks());

      remoteVideo.srcObject = remoteStream;

      // Wait for remote video to start playing
      remoteVideo.onloadedmetadata = () => {
        console.log("Remote video metadata loaded");
        console.log("Remote video dimensions:", remoteVideo.videoWidth, "x", remoteVideo.videoHeight);
      };

      remoteVideo.onplaying = () => {
        console.log("Remote video is playing");
        videoStatus.textContent = "Video chat active!";
      };

      // Update status immediately but will be confirmed when video plays
      videoStatus.textContent = "Connecting video...";
    }
  };

  // Handle ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log("Sending ICE candidate");
      ws.send(
        JSON.stringify({
          type: "ice-candidate",
          userId,
          targetId: partnerId,
          candidate: event.candidate,
        })
      );
    } else {
      console.log("All ICE candidates have been sent");
    }
  };

  // Monitor ICE connection state
  peerConnection.oniceconnectionstatechange = () => {
    console.log("ICE connection state:", peerConnection.iceConnectionState);

    if (peerConnection.iceConnectionState === "connected") {
      console.log("ICE connection established");
    } else if (peerConnection.iceConnectionState === "failed") {
      console.error("ICE connection failed");
      videoStatus.textContent = "Connection failed. Please try again.";
    } else if (peerConnection.iceConnectionState === "disconnected") {
      console.warn("ICE connection disconnected");
      videoStatus.textContent = "Connection lost. Reconnecting...";
    }
  };

  // Monitor overall connection state
  peerConnection.onconnectionstatechange = () => {
    console.log("Connection state:", peerConnection.connectionState);

    if (peerConnection.connectionState === "connected") {
      console.log("Peer connection established successfully");
    } else if (peerConnection.connectionState === "failed") {
      console.error("Peer connection failed");
      videoStatus.textContent = "Connection failed. Click 'Stop Chat' and try again.";
    }
  };

  // Only create offer if this user is the offerer
  if (isOfferer) {
    console.log("Creating offer as offerer...");
    peerConnection
      .createOffer()
      .then((offer) => {
        console.log("Created offer:", offer);
        return peerConnection.setLocalDescription(offer);
      })
      .then(() => {
        console.log("Set local description");
        ws.send(
          JSON.stringify({
            type: "offer",
            userId,
            targetId: partnerId,
            offer: peerConnection.localDescription,
          })
        );
        console.log("Sent offer to partner");
      })
      .catch((error) => {
        console.error("Error creating offer:", error);
      });
  } else {
    console.log("Waiting for offer as answerer...");
  }
}

function handleOffer(data) {
  console.log("Received offer from:", data.from);
  partnerId = data.from;

  // Set remote description and create answer
  peerConnection
    .setRemoteDescription(data.offer)
    .then(() => {
      console.log("Set remote description from offer");
      // Add buffered ICE candidates
      console.log("Adding buffered ICE candidates:", iceCandidatesBuffer.length);
      iceCandidatesBuffer.forEach((candidate) => {
        peerConnection.addIceCandidate(candidate);
      });
      iceCandidatesBuffer = [];
    })
    .then(() => {
      console.log("Creating answer...");
      return peerConnection.createAnswer();
    })
    .then((answer) => {
      console.log("Created answer:", answer);
      return peerConnection.setLocalDescription(answer);
    })
    .then(() => {
      console.log("Set local description, sending answer");
      ws.send(
        JSON.stringify({
          type: "answer",
          userId,
          targetId: partnerId,
          answer: peerConnection.localDescription,
        })
      );
      console.log("Sent answer to partner");
    })
    .catch((error) => {
      console.error("Error handling offer:", error);
      videoStatus.textContent = "Error establishing connection. Please try again.";
    });
}

function handleAnswer(data) {
  console.log("Received answer from:", data.from);
  peerConnection.setRemoteDescription(data.answer)
    .then(() => {
      console.log("Set remote description from answer");
    })
    .catch((error) => {
      console.error("Error handling answer:", error);
    });
}

function handleIceCandidate(data) {
  console.log("Received ICE candidate from:", data.from);
  if (peerConnection && peerConnection.remoteDescription) {
    peerConnection.addIceCandidate(data.candidate)
      .then(() => {
        console.log("Added ICE candidate");
      })
      .catch((error) => {
        console.error("Error adding ICE candidate:", error);
      });
  } else {
    console.log("Buffering ICE candidate (no remote description yet)");
    iceCandidatesBuffer.push(data.candidate);
  }
}

function handlePartnerDisconnect() {
  console.log("Partner disconnected");

  if (currentMode === "text") {
    textStatus.textContent = "Partner disconnected. Waiting for new partner...";
    messageInput.disabled = true;
    sendBtn.disabled = true;
    partnerId = null;
  } else if (currentMode === "video") {
    // Close existing peer connection
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }

    // Clear remote video
    remoteVideo.srcObject = null;

    // Reset state
    partnerId = null;
    iceCandidatesBuffer = [];

    videoStatus.textContent = "Partner disconnected. Waiting for new partner...";
  }

  // Server will put us back in queue
}
