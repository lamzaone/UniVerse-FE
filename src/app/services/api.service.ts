import axios from 'axios';

const api = axios.create({
  baseURL: 'http://lamzaone.go.ro:8000/api',
});

// TODO: FINISH THIS
// Add interceptor to attach token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('jwt_token'); // or use a proper AuthService
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

export default api;
