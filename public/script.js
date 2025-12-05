// Generate random user ID
const userId = Math.random().toString(36).substring(2, 15);

// WebSocket connection
const ws = new WebSocket("ws://localhost:3000");

// DOM elements
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusDiv = document.getElementById("status");

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

// Event listeners
startBtn.addEventListener("click", startChat);
stopBtn.addEventListener("click", stopChat);

// WebSocket event handlers
ws.onopen = () => {
  console.log("Connected to server");
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log("Received:", data);

  switch (data.type) {
    case "waiting":
      statusDiv.textContent = "Waiting for a partner...";
      break;
    case "paired":
      partnerId = data.partnerId;
      isOfferer = data.isOfferer;
      statusDiv.textContent = "Connected! Starting video...";
      startWebRTC();
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
  }
};

ws.onclose = () => {
  console.log("Disconnected from server");
  stopChat();
};

// Functions
async function startChat() {
  try {
    // Get user media
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    localVideo.srcObject = localStream;

    // Send join message
    ws.send(JSON.stringify({ type: "join", userId }));

    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusDiv.textContent = "Joining chat...";
  } catch (error) {
    console.error("Error accessing media devices:", error);
    statusDiv.textContent = "Error: Could not access camera/microphone";
  }
}

function stopChat() {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  if (peerConnection) {
    peerConnection.close();
  }
  remoteVideo.srcObject = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusDiv.textContent = 'Chat stopped. Click "Start Chat" to begin again.';
  partnerId = null;
}

function startWebRTC() {
  peerConnection = new RTCPeerConnection(rtcConfig);

  // Add local stream
  localStream
    .getTracks()
    .forEach((track) => peerConnection.addTrack(track, localStream));

  // Handle remote stream
  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    statusDiv.textContent = "Video chat active!";
  };

  // Handle ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(
        JSON.stringify({
          type: "ice-candidate",
          userId,
          targetId: partnerId,
          candidate: event.candidate,
        })
      );
    }
  };

  // Only create offer if this user is the offerer
  if (isOfferer) {
    peerConnection
      .createOffer()
      .then((offer) => peerConnection.setLocalDescription(offer))
      .then(() => {
        ws.send(
          JSON.stringify({
            type: "offer",
            userId,
            targetId: partnerId,
            offer: peerConnection.localDescription,
          })
        );
      });
  }
}

function handleOffer(data) {
  partnerId = data.from;

  // Set remote description and create answer
  peerConnection
    .setRemoteDescription(data.offer)
    .then(() => {
      // Add buffered ICE candidates
      iceCandidatesBuffer.forEach((candidate) => {
        peerConnection.addIceCandidate(candidate);
      });
      iceCandidatesBuffer = [];
    })
    .then(() => peerConnection.createAnswer())
    .then((answer) => peerConnection.setLocalDescription(answer))
    .then(() => {
      ws.send(
        JSON.stringify({
          type: "answer",
          userId,
          targetId: partnerId,
          answer: peerConnection.localDescription,
        })
      );
    })
    .catch((error) => {
      console.error("Error handling offer:", error);
    });
}

function handleAnswer(data) {
  peerConnection.setRemoteDescription(data.answer);
}

function handleIceCandidate(data) {
  if (peerConnection.remoteDescription) {
    peerConnection.addIceCandidate(data.candidate);
  } else {
    iceCandidatesBuffer.push(data.candidate);
  }
}

function handlePartnerDisconnect() {
  remoteVideo.srcObject = null;
  statusDiv.textContent = "Partner disconnected. Waiting for new partner...";
  partnerId = null;
  // Server will put us back in queue
}
