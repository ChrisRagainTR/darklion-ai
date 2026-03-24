'use strict';

/**
 * Preload script — bridges the renderer process to the main process.
 * Exposes only the specific APIs the renderer needs.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Called when a new print job is ready to route
  onJobReady: (callback) => {
    ipcRenderer.on('job-ready', (event, data) => callback(data));
  },

  // Search for clients
  search: (query) => ipcRenderer.invoke('search', query),

  // Upload a document
  upload: (params) => ipcRenderer.invoke('upload', params),

  // Notify main that upload completed
  uploadComplete: (filePath) => ipcRenderer.send('upload-complete', { filePath }),

  // Cancel — close the window without uploading
  cancel: (filePath) => ipcRenderer.send('cancel', { filePath }),

  // Login
  login: (email, password) => ipcRenderer.invoke('login', { email, password }),

  // Notify main that login succeeded
  loginSuccess: () => ipcRenderer.send('login-success'),

  // Logout
  logout: () => ipcRenderer.send('logout'),
});
