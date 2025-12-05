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

    // Send join message
    ws.send(JSON.stringify({ type: "join", userId }));

    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusDiv.textContent = "Joining chat...";

    console.log("Successfully started chat, waiting for partner...");
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

    statusDiv.textContent = errorMessage;
  }
}

function stopChat() {
  console.log("Stopping chat...");

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

  // Clear video sources
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;

  // Reset state
  startBtn.disabled = false;
  stopBtn.disabled = true;
  statusDiv.textContent = 'Chat stopped. Click "Start Chat" to begin again.';
  partnerId = null;
  isOfferer = false;
  iceCandidatesBuffer = [];

  console.log("Chat stopped and cleaned up");
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
        statusDiv.textContent = "Video chat active!";
      };

      // Update status immediately but will be confirmed when video plays
      statusDiv.textContent = "Connecting video...";
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
      statusDiv.textContent = "Connection failed. Please try again.";
    } else if (peerConnection.iceConnectionState === "disconnected") {
      console.warn("ICE connection disconnected");
      statusDiv.textContent = "Connection lost. Reconnecting...";
    }
  };

  // Monitor overall connection state
  peerConnection.onconnectionstatechange = () => {
    console.log("Connection state:", peerConnection.connectionState);

    if (peerConnection.connectionState === "connected") {
      console.log("Peer connection established successfully");
    } else if (peerConnection.connectionState === "failed") {
      console.error("Peer connection failed");
      statusDiv.textContent = "Connection failed. Click 'Stop Chat' and try again.";
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
      statusDiv.textContent = "Error establishing connection. Please try again.";
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

  statusDiv.textContent = "Partner disconnected. Waiting for new partner...";
  // Server will put us back in queue
}
