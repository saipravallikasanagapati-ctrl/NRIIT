import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import '../styles/ReportIssue.css';
import * as tf from "@tensorflow/tfjs";
import * as mobilenet from "@tensorflow-models/mobilenet";
import { detectAIImage } from '../utils/aiImageDetector';

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { API_BASE_URL } from "../config";

delete L.Icon.Default.prototype._getIconUrl;

L.Icon.Default.mergeOptions({
  iconRetinaUrl: require("leaflet/dist/images/marker-icon-2x.png"),
  iconUrl: require("leaflet/dist/images/marker-icon.png"),
  shadowUrl: require("leaflet/dist/images/marker-shadow.png"),
});

function ReportIssue() {
  const [formData, setFormData] = useState({
    issueType: '',
    title: '',
    description: '',
    location: {
      streetName: '',
      area: '',
      city: '',
      district: '',
      state: '',
      municipality: ''
    },
    latitude: null,
    longitude: null,
    image: null
  });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [previewSrc, setPreviewSrc] = useState(null);
const [model, setModel] = useState(null);
const [aiResult, setAiResult] = useState(null);
const [aiDetecting, setAiDetecting] = useState(false);



  const handleLocationChange = (e) => {
    const { name, value } = e.target;
    setFormData({
      ...formData,
      location: {
        ...formData.location,
        [name]: value
      }
    });
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData({
      ...formData,
      [name]: value
    });
  };

  const handleImageChange = (e) => {
    setFormData({
      ...formData,
      image: e.target.files[0]
    });
    if (e.target.files[0]) {
      try {
        const url = URL.createObjectURL(e.target.files[0]);
        setPreviewSrc(url);
      } catch (err) {
        setPreviewSrc(null);
      }
    }
  };

  useEffect(() => {
    // Load MobileNet on mount
    const loadModel = async () => {
      try {
        await tf.ready();
        const loadedModel = await mobilenet.load({ version: 2, alpha: 1.0 });
        setModel(loadedModel);
        console.log("MobileNet AI Model Loaded.");
      } catch (err) {
        console.error("Failed to load AI model", err);
      }
    };
    loadModel();

    return () => {
      // cleanup camera stream and object URLs
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
      if (previewSrc) URL.revokeObjectURL(previewSrc);
    };
  }, [previewSrc]);

  const validateImageWithAI = async (imageElement) => {
    setAiDetecting(true);
    setAiResult(null);

    try {
      // ── STEP 1: Real vs AI-Generated Detection ──────────────────────────
      const detection = await detectAIImage(imageElement, formData.image);
      console.log('AI Detection Result:', detection);

      if (!detection.isReal) {
        setAiResult({
          type: 'ai_generated',
          confidence: detection.confidence,
          reason: detection.reason,
          scores: detection.scores
        });
        setFormData(prev => ({ ...prev, image: null }));
        setPreviewSrc(null);
        setAiDetecting(false);
        return false;
      }

      // ── STEP 2: MobileNet Content Classification (on real photos) ──────
      if (model) {
        const predictions = await model.classify(imageElement);
        const labels = predictions.map(p => p.className.toLowerCase()).join(' ');
        const topLabel = predictions[0]?.className || 'unknown';
        const topConfidence = predictions[0]?.probability ? (predictions[0].probability * 100).toFixed(1) : '0';
        console.log('MobileNet Labels:', labels);

        // ── Image Color/Texture Analysis for smarter classification ──
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = imageElement.naturalWidth || imageElement.width || 200;
        canvas.height = imageElement.naturalHeight || imageElement.height || 200;
        ctx.drawImage(imageElement, 0, 0, canvas.width, canvas.height);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

        // Calculate dominant color channels
        let darkPixels = 0, grayPixels = 0;
        const pixelCount = imgData.length / 4;
        for (let i = 0; i < imgData.length; i += 4) {
          const brightness = (imgData[i] + imgData[i+1] + imgData[i+2]) / 3;
          if (brightness < 80) darkPixels++;
          const diff = Math.abs(imgData[i] - imgData[i+1]) + Math.abs(imgData[i+1] - imgData[i+2]);
          if (diff < 30 && brightness > 60 && brightness < 180) grayPixels++;
        }
        const darkRatio = darkPixels / pixelCount;
        const grayRatio = grayPixels / pixelCount;

        // Auto-fill logic
        const fileName = formData.image?.name?.toLowerCase() || '';
        let detectedType = 'other';
        let autoTitle = '';
        let autoDesc = '';
        const locationStr = formData.location.streetName || formData.location.area || 'reported location';

        // ── POTHOLE keywords (expanded with MobileNet misclassifications)
        const potholeKeywords = ['pothole', 'hole', 'asphalt', 'crater', 'pit', 'manhole', 'grating', 'grate', 'turtle', 'terrapin', 'tortoise'];
        // ── GARBAGE keywords
        const garbageKeywords = ['trash', 'garbage', 'dump', 'waste', 'plastic', 'bag', 'container', 'bucket', 'debris', 'litter', 'rubbish', 'bin', 'can'];
        // ── STREETLIGHT keywords
        const lightKeywords = ['light', 'lamp', 'streetlight', 'pole', 'bulb', 'lantern', 'spotlight', 'electric'];
        // ── WATER keywords
        const waterKeywords = ['leak', 'water', 'flood', 'drain', 'pipe', 'puddle', 'wet', 'overflow', 'sewer', 'sewage'];
        // ── ROAD keywords
        const roadKeywords = ['road', 'street', 'concrete', 'sidewalk', 'curb', 'pavement', 'bridge', 'highway', 'path', 'crack'];

        const matchAny = (keywords) => keywords.some(k => labels.includes(k) || fileName.includes(k));

        if (matchAny(potholeKeywords) || (grayRatio > 0.3 && darkRatio > 0.15)) {
          detectedType = 'pothole';
          autoTitle = 'Pothole / Road Damage Detected on ' + locationStr;
          autoDesc = `🔍 AI ANALYSIS REPORT\n━━━━━━━━━━━━━━━━━━━━\n✅ Image verified as REAL photograph\n📊 AI Classification: ${topLabel} (${topConfidence}% confidence)\n\n⚠️ ISSUE: Dangerous pothole/road damage identified\n📍 Location: ${locationStr}\n📝 Details: A significant pothole or road surface damage has been detected through AI-powered image analysis. The damaged area poses risk to vehicles and pedestrians. Immediate repair and leveling is recommended.\n\n🤖 Auto-generated by CivicSense AI`;
        }
        else if (matchAny(garbageKeywords)) {
          detectedType = 'garbage';
          autoTitle = 'Garbage Overflow / Illegal Dumping at ' + locationStr;
          autoDesc = `🔍 AI ANALYSIS REPORT\n━━━━━━━━━━━━━━━━━━━━\n✅ Image verified as REAL photograph\n📊 AI Classification: ${topLabel} (${topConfidence}% confidence)\n\n⚠️ ISSUE: Garbage accumulation or illegal dumping detected\n📍 Location: ${locationStr}\n📝 Details: Significant waste buildup has been identified. This poses public health risks and requires urgent municipal cleanup action.\n\n🤖 Auto-generated by CivicSense AI`;
        }
        else if (matchAny(lightKeywords)) {
          detectedType = 'streetlight';
          autoTitle = 'Streetlight / Public Lighting Issue at ' + locationStr;
          autoDesc = `🔍 AI ANALYSIS REPORT\n━━━━━━━━━━━━━━━━━━━━\n✅ Image verified as REAL photograph\n📊 AI Classification: ${topLabel} (${topConfidence}% confidence)\n\n⚠️ ISSUE: Faulty or damaged streetlight detected\n📍 Location: ${locationStr}\n📝 Details: Public lighting infrastructure issue identified. Area may be unsafe at night. Electrical inspection and repair recommended.\n\n🤖 Auto-generated by CivicSense AI`;
        }
        else if (matchAny(waterKeywords)) {
          detectedType = 'water_leak';
          autoTitle = 'Water Leakage / Drainage Problem at ' + locationStr;
          autoDesc = `🔍 AI ANALYSIS REPORT\n━━━━━━━━━━━━━━━━━━━━\n✅ Image verified as REAL photograph\n📊 AI Classification: ${topLabel} (${topConfidence}% confidence)\n\n⚠️ ISSUE: Water leakage or drainage blockage detected\n📍 Location: ${locationStr}\n📝 Details: Possible pipeline burst or clogged drainage system. May cause waterlogging and infrastructure damage if not addressed promptly.\n\n🤖 Auto-generated by CivicSense AI`;
        }
        else if (matchAny(roadKeywords)) {
          detectedType = 'damaged_road';
          autoTitle = 'Road / Infrastructure Damage at ' + locationStr;
          autoDesc = `🔍 AI ANALYSIS REPORT\n━━━━━━━━━━━━━━━━━━━━\n✅ Image verified as REAL photograph\n📊 AI Classification: ${topLabel} (${topConfidence}% confidence)\n\n⚠️ ISSUE: Road or public infrastructure deterioration\n📍 Location: ${locationStr}\n📝 Details: General road damage or public infrastructure issue detected by AI scanner. Area needs maintenance and safety evaluation.\n\n🤖 Auto-generated by CivicSense AI`;
        }
        else {
          // Smart fallback — always give a meaningful result
          detectedType = 'other';
          autoTitle = 'Civic Infrastructure Issue Detected at ' + locationStr;
          autoDesc = `🔍 AI ANALYSIS REPORT\n━━━━━━━━━━━━━━━━━━━━\n✅ Image verified as REAL photograph\n📊 AI Classification: ${topLabel} (${topConfidence}% confidence)\n\n⚠️ ISSUE: Civic infrastructure issue requiring attention\n📍 Location: ${locationStr}\n📝 Details: AI analysis has verified this as a real photograph of a civic issue. Visual content analysis detected: ${topLabel}. Municipal authorities should inspect and assess the situation.\n\n🤖 Auto-generated by CivicSense AI`;
        }

        setFormData(prev => ({
          ...prev,
          issueType: detectedType,
          title: autoTitle,
          description: autoDesc
        }));
      }

      setAiResult({
        type: 'real',
        confidence: detection.confidence,
        reason: detection.reason,
        scores: detection.scores
      });
      setAiDetecting(false);
      return true;

    } catch (err) {
      console.error('Validation error:', err);
      setAiDetecting(false);
      return true; // fail-open if error
    }
  };
  const stopCamera = () => {
  if (streamRef.current) {
    streamRef.current.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  }

  if (videoRef.current) {
    videoRef.current.pause();
    videoRef.current.srcObject = null;
  }

  setCameraActive(false);
};
const startCamera = async () => {
  setCameraError("");

  try {
    // Stop previous stream if exists
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false
    });

    streamRef.current = stream;

    if (videoRef.current) {
      videoRef.current.srcObject = stream;

      videoRef.current.onloadeddata = () => {
        videoRef.current.play();
      };
    }

    setCameraActive(true);

  } catch (err) {
    console.error("Camera error:", err);
    setCameraError("Unable to access camera. Check permissions.");
  }
};



  const capturePhoto = async () => {
    try {
      const video = videoRef.current;
      if (!video) return setCameraError('Camera not ready');
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      const file = new File([blob], `camera_${Date.now()}.jpg`, { type: 'image/jpeg' });
      setFormData(prev => ({ ...prev, image: file }));
      const url = URL.createObjectURL(file);
      setPreviewSrc(url);
      stopCamera();
      setSuccess('Photo captured');
    } catch (err) {
      console.error('Capture failed', err);
      setCameraError('Capture failed');
    }
  };


  const handleCopyMunicipality = async () => {
    const muni = formData.location.municipality || '';
    if (!muni) return setError('No municipality to copy');
    try {
      await navigator.clipboard.writeText(muni);
      setSuccess('Municipality copied to clipboard');
    } catch (err) {
      setError('Failed to copy');
    }
  };

  const handleContactMunicipality = () => {
    const muni = formData.location.municipality || '';
    const subject = encodeURIComponent('Civic Issue: ' + (formData.title || formData.issueType || ''));
    const body = encodeURIComponent(`Please contact the municipality (${muni}) regarding an issue at coordinates: ${formData.latitude}, ${formData.longitude}`);
    window.open(`mailto:?subject=${subject}&body=${body}`);
  };

  const handleChangeLocation = () => {
    // allow user to change manual fields
    setFormData({
      ...formData,
      latitude: null,
      longitude: null,
      location: {
        streetName: '', area: '', city: '', district: '', state: '', municipality: ''
      }
    });
    setSuccess('You can now enter location manually');
  };

const handleGetLocation = () => {
  if (!navigator.geolocation) {
    setError('Geolocation is not supported by this browser');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;

      // Save coordinates first
      setFormData(prev => ({
        ...prev,
        latitude: lat,
        longitude: lon
      }));

      // Reverse geocoding with better error handling
      fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`, {
        headers: {
          "Accept": "application/json"
        }
      })
        .then(res => {
          if (!res.ok) {
            throw new Error("Reverse geocoding API failed");
          }
          return res.json();
        })
        .then(data => {
          if (!data || !data.address) {
            throw new Error("No address data");
          }

          const addr = data.address;

          setFormData(prev => ({
            ...prev,
            location: {
              streetName: addr.road || addr.pedestrian || addr.cycleway || '',
              area: addr.neighbourhood || addr.suburb || addr.city_district || '',
              city: addr.city || addr.town || addr.village || '',
              district: addr.county || addr.state_district || '',
              state: addr.state || '',
              municipality: addr.city || addr.town || addr.village || addr.county || ''
            }
          }));

          setSuccess('Location obtained successfully');
        })
        .catch((err) => {
          console.error('Reverse geocode failed:', err);

          // Fallback if API fails
          setFormData(prev => ({
            ...prev,
            location: {
              streetName: "GPS Location",
              area: "",
              city: `Lat: ${lat.toFixed(5)}`,
              district: "",
              state: "",
              municipality: ""
            }
          }));

          setSuccess('Location coordinates obtained (address lookup limited)');
        });
    },
    (error) => {
      setError('Could not get location: ' + error.message);
    }
  );
};


  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    const token = localStorage.getItem('token');
    if (!token) {
      setError('Please login first');
      setLoading(false);
      return;
    }

    try {
      // Use FormData for file uploads (multipart/form-data)
      const fd = new FormData();
      fd.append('issueType', formData.issueType);
      fd.append('title', formData.title);
      fd.append('description', formData.description);
      fd.append('latitude', formData.latitude || '');
      fd.append('longitude', formData.longitude || '');
      fd.append('location', JSON.stringify(formData.location || {}));
      if (formData.image instanceof File) {
        fd.append('image', formData.image);
      } else if (formData.image) {
        // allow existing string/image URL/data
        fd.append('image', formData.image);
      }

      const response = await axios.post(`${API_BASE_URL}/api/issues`, fd, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'multipart/form-data'
        }
      });

      if (response.data.success) {
        setSuccess('Issue reported successfully!');
        setFormData({
          issueType: '',
          title: '',
          description: '',
          location: {
            streetName: '',
            area: '',
            city: '',
            district: '',
            state: '',
            municipality: ''
          },
          latitude: null,
          longitude: null,
          image: null
        });
        setTimeout(() => navigate('/citizen-dashboard'), 2000);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to report issue');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="report-issue-container">
      <div className="report-issue-box">
        <h2>Report a Civic Issue</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group ai-detection-box" style={{ background: '#f4f6fb', padding: '15px', borderRadius: '8px', borderLeft: '4px solid #667eea' }}>
            <h3 style={{ margin: '0 0 10px 0', color: '#667eea', fontSize: '16px' }}>
              🤖 AI Auto-Detection Enabled
            </h3>
            <p style={{ margin: 0, color: '#555', fontSize: '14px' }}>
              Simply upload an image of the civic issue. Our AI will automatically detect crop factors and classify the issue type (e.g., Pothole, Garbage) for you upon submission!
            </p>
          </div>

          <div className="form-group">
            <label>Upload Image:</label>
            <div className="image-upload-box">
              <input
                type="file"
                accept="image/*"
                onChange={handleImageChange}
                id="fileInput"
              />
              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <button type="button" className="btn-secondary" onClick={() => document.getElementById('fileInput').click()}>Choose Image</button>
                <button type="button" className="btn-secondary" onClick={startCamera}>Use Camera</button>
              </div>

              {cameraError && <div className="error" style={{ marginTop: 8 }}>{cameraError}</div>}

              {cameraActive && (
                <div className="camera-box">
<video
  ref={videoRef}
  autoPlay
  playsInline
  muted
  style={{
    width: "100%",
    height: "300px",
    objectFit: "cover",
    borderRadius: "10px",
    background: "black"
  }}
/>

                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button type="button" className="btn-location" onClick={capturePhoto}>Capture</button>
                    <button type="button" className="btn-secondary" onClick={stopCamera}>Close</button>
                  </div>
                </div>
              )}

              {previewSrc && (
                <div style={{ marginTop: 10 }}>
                  <img
                    id="previewImage"
                    src={previewSrc}
                    alt="preview"
                    style={{ maxWidth: 200, borderRadius: 8, border: '2px solid #e5e7eb', display: 'block' }}
                    onLoad={(e) => {
                      if (formData.image) validateImageWithAI(e.target);
                    }}
                  />
                </div>
              )}

              {/* Detecting spinner */}
              {aiDetecting && (
                <div style={{ marginTop: 14, padding: '14px 16px', background: '#f0f4ff', borderRadius: 10, borderLeft: '4px solid #6366f1', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 20, height: 20, border: '3px solid #c7d2fe', borderTopColor: '#4338ca', borderRadius: '50%', animation: 'spin 0.8s linear infinite', flexShrink: 0 }} />
                  <div>
                    <div style={{ fontWeight: 600, color: '#3730a3', fontSize: 14 }}>🔬 Analyzing Image...</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Checking EXIF metadata, noise patterns, edge frequency & color distribution</div>
                  </div>
                </div>
              )}

              {/* Detection result panel */}
              {aiResult && !aiDetecting && (() => {
                const isReal = aiResult.type === 'real';
                const s = aiResult.scores || {};
                const factors = [
                  { label: 'EXIF Metadata', score: s.exifScore, tip: 'Camera metadata presence' },
                  { label: 'Sensor Noise', score: s.noiseScore, tip: 'Natural camera noise level' },
                  { label: 'Edge Frequency', score: s.edgeScore, tip: 'Edge variation (AI = too uniform)' },
                  { label: 'Color Channels', score: s.channelScore, tip: 'RGB channel correlation' },
                  { label: 'Block Artifacts', score: s.blockScore, tip: 'AI model grid patterns' },
                ];
                return (
                  <div style={{
                    marginTop: 14, borderRadius: 12, overflow: 'hidden',
                    border: `2px solid ${isReal ? '#10b981' : '#ef4444'}`,
                    background: isReal ? '#f0fdf4' : '#fef2f2'
                  }}>
                    {/* Header */}
                    <div style={{ padding: '12px 16px', background: isReal ? '#10b981' : '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>
                        {isReal ? '✅ REAL PHOTO VERIFIED' : '🤖 AI-GENERATED IMAGE DETECTED'}
                      </div>
                      <div style={{ background: 'rgba(255,255,255,0.25)', color: '#fff', borderRadius: 20, padding: '2px 12px', fontWeight: 700, fontSize: 13 }}>
                        {aiResult.confidence}% {isReal ? 'Real' : 'AI'}
                      </div>
                    </div>
                    {/* Reason */}
                    <div style={{ padding: '10px 16px', fontSize: 13, color: isReal ? '#065f46' : '#991b1b', borderBottom: '1px solid ' + (isReal ? '#a7f3d0' : '#fecaca') }}>
                      {isReal ? '📷' : '⚠️'} {aiResult.reason}
                    </div>
                    {/* Factor breakdown */}
                    <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Detection Breakdown</div>
                      {factors.map(f => (
                        <div key={f.label}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#374151', marginBottom: 3 }}>
                            <span>{f.label}</span>
                            <span style={{ color: f.score >= 60 ? '#10b981' : f.score >= 35 ? '#f59e0b' : '#ef4444', fontWeight: 600 }}>{f.score ?? '—'}%</span>
                          </div>
                          <div style={{ height: 5, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{
                              height: '100%', borderRadius: 3, transition: 'width 0.5s',
                              width: `${f.score ?? 0}%`,
                              background: f.score >= 60 ? '#10b981' : f.score >= 35 ? '#f59e0b' : '#ef4444'
                            }} />
                          </div>
                        </div>
                      ))}
                    </div>
                    {!isReal && (
                      <div style={{ padding: '10px 16px', background: '#fee2e2', color: '#991b1b', fontSize: 13, fontWeight: 500 }}>
                        ❌ Upload rejected. Please submit a real photo taken with your camera.
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>

          <div className="form-group">
            <label>Title</label>
            <input
              name="title"
              value={formData.title}
              onChange={handleChange}
              placeholder="AI will generate title from image..."
              required
            />
          </div>

          <div className="form-group">
            <label>Description:</label>
            <textarea
              name="description"
              value={formData.description}
              onChange={handleChange}
              placeholder="AI will generate description from image..."
              required
            />
          </div>

          <div className="location-section">
            <h3>Location Details</h3>
            <button type="button" className="btn-location" onClick={handleGetLocation}>
              Get Current Location
            </button>

            {formData.latitude && formData.longitude && (
              <div style={{ marginTop: '15px', marginBottom: '15px', padding: '10px', background: '#eef2ff', borderRadius: '5px', borderLeft: '4px solid #667eea', fontSize: '14px', color: '#333' }}>
                <strong style={{ color: '#667eea' }}>Latitude:</strong> {formData.latitude.toFixed(6)} <br/>
                <strong style={{ color: '#667eea' }}>Longitude:</strong> {formData.longitude.toFixed(6)}
              </div>
            )}

            <div className="form-row">
              <div className="form-group">
                <label>Street Name:</label>
                <input
                  type="text"
                  name="streetName"
                  value={formData.location.streetName}
                  onChange={handleLocationChange}
                  required
                />
              </div>
              <div className="form-group">
                <label>Area:</label>
                <input
                  type="text"
                  name="area"
                  value={formData.location.area}
                  onChange={handleLocationChange}
                  required
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>City:</label>
                <input
                  type="text"
                  name="city"
                  value={formData.location.city}
                  onChange={handleLocationChange}
                  required
                />
              </div>
              <div className="form-group">
                <label>District:</label>
                <input
                  type="text"
                  name="district"
                  value={formData.location.district}
                  onChange={handleLocationChange}
                  required
                />
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>State:</label>
                <input
                  type="text"
                  name="state"
                  value={formData.location.state}
                  onChange={handleLocationChange}
                  required
                />
              </div>
              <div className="form-group">
                <label>Municipality:</label>
                <input
                  type="text"
                  name="municipality"
                  value={formData.location.municipality}
                  onChange={handleLocationChange}
                  required
                />
              </div>
            </div>

            {formData.latitude && formData.longitude && (
              <div className="location-panel">
                <div>
                  <strong>Location:</strong> {formData.location.streetName || ''} {formData.location.area ? `, ${formData.location.area}` : ''}
                  <div>{formData.location.city}{formData.location.district ? `, ${formData.location.district}` : ''}</div>
                </div>
                <div className="location-actions">
                  <button type="button" className="btn-location" onClick={() => window.open(`https://www.google.com/maps?q=${formData.latitude},${formData.longitude}`, '_blank')}>Get directions</button>
                  <button type="button" className="btn-secondary" onClick={handleCopyMunicipality}>Copy municipality</button>
                  <button type="button" className="btn-secondary" onClick={handleContactMunicipality}>Contact municipality</button>
                  <button type="button" className="btn-secondary" onClick={handleChangeLocation}>Change</button>
                </div>
              </div>
            )}
          </div>

          {error && <p className="error">{error}</p>}
          {success && <p className="success">{success}</p>}

          <button type="submit" disabled={loading}>
            {loading ? 'Reporting...' : 'Submit Report'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default ReportIssue;
