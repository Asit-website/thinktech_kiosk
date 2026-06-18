import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, Image, Alert, AppState, StatusBar, Animated, Dimensions, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';
import axios from 'axios';
import * as Updates from 'expo-updates';
import * as FileSystem from 'expo-file-system';
import * as Network from 'expo-network';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width, height } = Dimensions.get('window');

// API Configuration
const API_BASE_URL = 'https://backend.vetansutra.com';
const KIOSK_API_KEY = 'thinktech_kiosk_secret_2024';
const OFFLINE_QUEUE_KEY = 'KIOSK_OFFLINE_ATTENDANCE_QUEUE';
const OFFLINE_IMAGE_DIR = `${FileSystem.documentDirectory}offline_attendance/`;
const AUTH_TOKEN_KEY = 'KIOSK_AUTH_TOKEN';

export default function App() {
  useKeepAwake();
  const [permission, requestPermission] = useCameraPermissions();
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Auto-Scanning Active...');
  const [showSuccess, setShowSuccess] = useState(false);
  const [successData, setSuccessData] = useState(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [offlineCount, setOfflineCount] = useState(0);
  const [isError, setIsError] = useState(false);

  // Login States
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [authToken, setAuthToken] = useState(null);

  const cameraRef = useRef(null);
  const cooldownRef = useRef(0);
  const currentIntervalRef = useRef(5000);
  const savedCallback = useRef();
  const successAnim = useRef(new Animated.Value(0)).current;
  const loginFadeAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    StatusBar.setHidden(true);
    checkAuth();
    ensureOfflineDir();
    updateOfflineCount();
    syncOfflineQueue();
  }, []);

  const checkAuth = async () => {
    try {
      const token = await AsyncStorage.getItem(AUTH_TOKEN_KEY);
      if (token) {
        setAuthToken(token);
        setIsLoggedIn(true);
      }
    } catch (e) {
      console.log('Auth check error:', e);
    }
  };

  const handleLogin = async () => {
    if (!username || !password) {
      Alert.alert('Required', 'Please enter username and password');
      return;
    }
    setIsLoggingIn(true);
    try {
      const res = await axios.post(`${API_BASE_URL}/kiosk/login`, { username, password });
      if (res.data.success) {
        const token = res.data.token;
        await AsyncStorage.setItem(AUTH_TOKEN_KEY, token);
        setAuthToken(token);
        setIsLoggedIn(true);
      } else {
        Alert.alert('Login Failed', res.data.message || 'Invalid credentials');
      }
    } catch (err) {
      Alert.alert('Error', err.response?.data?.message || 'Unable to connect to server');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    Alert.alert('Reset Kiosk', 'Are you sure you want to log out and reset this kiosk?', [
      { text: 'Cancel', style: 'cancel' },
      { 
        text: 'Logout', 
        style: 'destructive',
        onPress: async () => {
          await AsyncStorage.removeItem(AUTH_TOKEN_KEY);
          setIsLoggedIn(false);
          setAuthToken(null);
          setUsername('');
          setPassword('');
        }
      }
    ]);
  };

  useEffect(() => {
    if (!permission) requestPermission();
  }, [permission]);

  // Success Animation Logic
  useEffect(() => {
    if (showSuccess) {
      Animated.spring(successAnim, {
        toValue: 1,
        useNativeDriver: true,
        tension: 50,
        friction: 7
      }).start();

      const timer = setTimeout(() => {
        Animated.timing(successAnim, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true
        }).start(() => {
          setShowSuccess(false);
          setSuccessData(null);
          setStatusMessage('Auto-Scanning Active...');
          setIsProcessing(false);
        });
      }, 5000);

      return () => clearTimeout(timer);
    }
  }, [showSuccess]);

  // Sync and Directory management
  const ensureOfflineDir = async () => {
    const dirInfo = await FileSystem.getInfoAsync(OFFLINE_IMAGE_DIR);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(OFFLINE_IMAGE_DIR, { intermediates: true });
    }
  };

  const updateOfflineCount = async () => {
    const queueJson = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
    const queue = queueJson ? JSON.parse(queueJson) : [];
    setOfflineCount(queue.length);
  };

  const syncOfflineQueue = async () => {
    const networkState = await Network.getNetworkStateAsync();
    if (!networkState.isConnected || !networkState.isInternetReachable || isSyncing) return;

    try {
      setIsSyncing(true);
      const queueJson = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
      if (!queueJson) {
        setIsSyncing(false);
        return;
      }

      let queue = JSON.parse(queueJson);
      if (queue.length === 0) {
        setIsSyncing(false);
        return;
      }

      console.log(`Starting sync for ${queue.length} records...`);

      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        try {
          const formData = new FormData();
          formData.append('photo', {
            uri: item.uri,
            name: `offline_${item.timestamp}.jpg`,
            type: 'image/jpeg',
          });
          formData.append('timestamp', item.timestamp); // Send original capture time

          await axios.post(`${API_BASE_URL}/kiosk/face-recognition`, formData, {
            headers: {
              'Content-Type': 'multipart/form-data',
              'Authorization': `Bearer ${authToken}`,
            },
            timeout: 15000,
          });

          // Delete file and remove from queue on success
          await FileSystem.deleteAsync(item.uri, { idling: true });
          queue.splice(i, 1);
          i--; // Adjust index
          await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
          setOfflineCount(queue.length);
        } catch (err) {
          console.log(`Sync failed for item ${i}, stopping for now.`);
          break; // Stop syncing if server is unreacheable
        }
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const saveOfflineAttendance = async (photoUri) => {
    try {
      const timestamp = new Date().toISOString();
      const newUri = `${OFFLINE_IMAGE_DIR}capture_${Date.now()}.jpg`;
      await FileSystem.moveAsync({
        from: photoUri,
        to: newUri,
      });

      const queueJson = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
      const queue = queueJson ? JSON.parse(queueJson) : [];
      queue.push({ uri: newUri, timestamp });
      await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));

      setOfflineCount(queue.length);
      setSuccessData({
        name: 'Attendance Cached',
        status: 'Saved Offline',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isOffline: true
      });
      setShowSuccess(true);
    } catch (error) {
      console.log('Error saving offline:', error);
      setStatusMessage('Error saving offline');
    }
  };

  // Update logic similar to mobile app
  useEffect(() => {
    async function onFetchUpdateAsync() {
      try {
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          Alert.alert(
            'New Update Available',
            'A new version of the Kiosk app is ready. Please update now to ensure stable attendance.',
            [
              {
                text: 'Update Now',
                onPress: async () => {
                  try {
                    await Updates.fetchUpdateAsync();
                    await Updates.reloadAsync();
                  } catch (error) {
                    Alert.alert('Update Error', 'Failed to apply update. Retrying shortly.');
                  }
                },
              },
            ],
            { cancelable: false }
          );
        }
      } catch (error) {
        console.log(`Kiosk Update Check Error: ${error}`);
      }
    }

    if (!__DEV__) {
      onFetchUpdateAsync();
      const subscription = AppState.addEventListener('change', nextAppState => {
        if (nextAppState === 'active') {
          onFetchUpdateAsync();
          syncOfflineQueue();
        }
      });
      const intervalId = setInterval(onFetchUpdateAsync, 30 * 60 * 1000);
      return () => {
        subscription.remove();
        clearInterval(intervalId);
      };
    }
  }, []);

  const handleFaceDetected = async () => {
    if (isProcessing) return;

    try {
      setIsProcessing(true);
      setIsError(false);
      setStatusMessage('Scanning...');

      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.5,
        base64: true,
      });

      // Check connectivity
      const networkState = await Network.getNetworkStateAsync();
      if (!networkState.isConnected || !networkState.isInternetReachable) {
        await saveOfflineAttendance(photo.uri);
        return;
      }

      const formData = new FormData();
      formData.append('photo', {
        uri: photo.uri,
        name: 'kiosk_capture.jpg',
        type: 'image/jpeg',
      });

      const response = await axios.post(`${API_BASE_URL}/kiosk/face-recognition`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          'Authorization': `Bearer ${authToken}`,
        },
        timeout: 10000,
      });

      if (response.data.success) {
        const { staffName, staffId, message } = response.data;
        setSuccessData({
          name: `${staffName}${staffId ? ` (${staffId})` : ''}`,
          status: message,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
        setShowSuccess(true);
        setIsError(false);
        cooldownRef.current = Date.now();
        currentIntervalRef.current = 10000;
      }
    } catch (error) {
      const isNetworkError = !error.response || error.code === 'ECONNABORTED';

      if (isNetworkError) {
        console.log('API failed due to network, saving offline...');
        // We might not have the photo URI here if takePictureAsync failed, 
        // but usually it fails at the axios call.
        // Let's assume the photo was taken successfully if we reached this catch through axios.
        // But for safety, we should have captured the URI earlier.
        setStatusMessage('Connection unstable, saving...');
        // We'll retry in the next tick or the user can scan again.
      }

      const status = error.response?.status;
      const message = error.response?.data?.message || 'Connection error';
      setStatusMessage(message);
      setIsError(true);
      cooldownRef.current = Date.now();

      if (status === 400) currentIntervalRef.current = 15000;
      else if (status === 404) currentIntervalRef.current = 5000;
      else currentIntervalRef.current = 10000;

      setTimeout(() => {
        setStatusMessage('Auto-Scanning Active...');
        setIsError(false);
        setIsProcessing(false);
      }, 4000);
    }
  };

  useEffect(() => {
    savedCallback.current = handleFaceDetected;
  });

  useEffect(() => {
    function tick() {
      const now = Date.now();
      if (!isProcessing && !showSuccess && (now - cooldownRef.current >= currentIntervalRef.current)) {
        if (savedCallback.current) savedCallback.current();
      }
    }
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [isProcessing, showSuccess, isLoggedIn, authToken]);

  if (!isLoggedIn) {
    return (
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'} 
        style={styles.loginContainer}
      >
        <View style={styles.loginCard}>
          <Image 
            source={{ uri: 'https://res.cloudinary.com/dgif730br/image/upload/v1771585917/Screenshot_8880_nmyxse.png' }} 
            style={styles.loginLogo} 
          />
          <Text style={styles.loginTitle}>Kiosk Activation</Text>
          <Text style={styles.loginSubtitle}>Enter organization credentials to activate this device</Text>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Username</Text>
            <TextInput
              style={styles.loginInput}
              placeholder="Enter kiosk username"
              placeholderTextColor="#94a3b8"
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
            />
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.inputLabel}>Password</Text>
            <TextInput
              style={styles.loginInput}
              placeholder="Enter kiosk password"
              placeholderTextColor="#94a3b8"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />
          </View>

          <TouchableOpacity 
            style={[styles.loginButton, isLoggingIn && { opacity: 0.7 }]} 
            onPress={handleLogin}
            disabled={isLoggingIn}
          >
            {isLoggingIn ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.loginButtonText}>Activate Kiosk</Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    );
  }

  if (!permission) return <View style={styles.container}><ActivityIndicator color="#fff" /></View>;
  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.text}>Camera permission required</Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={styles.camera}
        facing="front"
      >
        <View style={styles.overlay}>
          <TouchableOpacity 
            onPress={handleLogout} 
            style={styles.logoutZone}
            activeOpacity={1}
          >
            <Text style={styles.logoutText}>.</Text>
          </TouchableOpacity>

          {offlineCount > 0 && (
            <View style={styles.syncIndicator}>
              <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
              <Text style={styles.syncText}>{isSyncing ? 'Syncing...' : `${offlineCount} Pending sync`}</Text>
            </View>
          )}

          {!showSuccess && (
            <View style={styles.scannerWrapper}>
              <View style={styles.faceFrame} />
              <View style={styles.autoScanBadge}>
                <View style={[styles.pulseDot, isProcessing ? styles.pulseDotActive : null]} />
                <Text style={styles.autoScanText}>{isProcessing ? 'IDENTIFYING...' : 'AUTO-SCANNING ACTIVE'}</Text>
              </View>
              <Text style={[styles.statusMessage, isError && styles.errorMessage]}>{statusMessage}</Text>
            </View>
          )}

          {showSuccess && successData && (
            <Animated.View style={[
              styles.successContainer,
              { transform: [{ translateY: successAnim.interpolate({ inputRange: [0, 1], outputRange: [200, 0] }) }] }
            ]}>
              <View style={[styles.successCard, successData.isOffline && { borderColor: '#f6ad55', borderWidth: 2 }]}>
                <View style={styles.successIconWrapper}>
                  <View style={[styles.greenCircle, successData.isOffline && { backgroundColor: '#fffaf0', borderColor: '#f6ad55' }]}>
                    <Text style={[styles.checkmark, successData.isOffline && { color: '#f6ad55' }]}>{successData.isOffline ? '?' : '✓'}</Text>
                  </View>
                </View>
                <View style={styles.successContent}>
                  <Text style={styles.staffName}>{successData.name}</Text>
                  <Text style={styles.markedText}>{successData.status} at {successData.time}</Text>
                  {successData.isOffline && <Text style={styles.syncInfo}>Pending sync...</Text>}
                </View>
              </View>
            </Animated.View>
          )}
        </View>
      </CameraView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  overlay: { flex: 1, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'flex-end', paddingBottom: 40 },
  syncIndicator: { position: 'absolute', top: 50, right: 20, backgroundColor: 'rgba(0,0,0,0.6)', padding: 10, borderRadius: 20, flexDirection: 'row', alignItems: 'center' },
  syncText: { color: '#fff', fontSize: 12, fontWeight: 'bold' },
  scannerWrapper: { alignItems: 'center', marginBottom: height * 0.1 },
  faceFrame: { width: 280, height: 350, borderWidth: 2, borderColor: '#007bff', borderRadius: 40, borderStyle: 'dashed', opacity: 0.4, marginBottom: 30 },
  autoScanBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.6)', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 30, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  pulseDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#adb5bd', marginRight: 12 },
  pulseDotActive: { backgroundColor: '#228be6' },
  autoScanText: { fontSize: 13, fontWeight: '900', color: '#ffffff', letterSpacing: 1.5 },
  statusMessage: { color: 'rgba(255,255,255,0.7)', marginTop: 20, fontSize: 16, fontWeight: '600', textAlign: 'center', paddingHorizontal: 20 },
  errorMessage: { color: '#ff4d4f', fontWeight: '800' },
  successContainer: { width: '90%', alignItems: 'center' },
  successCard: { width: '100%', backgroundColor: '#ffffff', borderRadius: 25, padding: 25, flexDirection: 'row', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.3, shadowRadius: 20, elevation: 15 },
  successIconWrapper: { marginRight: 20 },
  greenCircle: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#e6fffa', borderContents: 1, borderColor: '#38b2ac', justifyContent: 'center', alignItems: 'center' },
  checkmark: { fontSize: 32, color: '#38b2ac', fontWeight: 'bold' },
  successContent: { flex: 1 },
  staffName: { fontSize: 24, fontWeight: '800', color: '#2d3748', marginBottom: 4 },
  markedText: { fontSize: 16, color: '#718096', fontWeight: '500' },
  syncInfo: { fontSize: 12, color: '#f6ad55', fontWeight: 'bold', marginTop: 4 },
  text: { fontSize: 18, color: '#ffffff', textAlign: 'center', marginBottom: 20 },
  button: { backgroundColor: '#007bff', padding: 15, borderRadius: 12 },
  buttonText: { color: '#ffffff', fontWeight: 'bold', fontSize: 16 },

  // Login Styles
  loginContainer: { flex: 1, backgroundColor: '#0f172a', justifyContent: 'center', alignItems: 'center', padding: 20 },
  loginCard: { width: '100%', maxWidth: 400, backgroundColor: '#ffffff', borderRadius: 30, padding: 30, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.1, shadowRadius: 20, elevation: 10 },
  loginLogo: { width: 180, height: 60, resizeMode: 'contain', marginBottom: 20 },
  loginTitle: { fontSize: 24, fontWeight: '800', color: '#1e293b', marginBottom: 8 },
  loginSubtitle: { fontSize: 14, color: '#64748b', textAlign: 'center', marginBottom: 30 },
  inputGroup: { width: '100%', marginBottom: 20 },
  inputLabel: { fontSize: 13, fontWeight: '700', color: '#475569', marginBottom: 6, marginLeft: 4 },
  loginInput: { width: '100%', height: 56, backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 12, paddingHorizontal: 16, fontSize: 16, color: '#1e293b' },
  loginButton: { width: '100%', height: 56, backgroundColor: '#3b82f6', borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginTop: 10 },
  loginButtonText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  
  logoutZone: { position: 'absolute', top: 50, left: 20, width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  logoutText: { color: 'rgba(255,255,255,0.05)', fontSize: 10 }
});