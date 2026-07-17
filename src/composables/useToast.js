import { ref } from 'vue';

export function useToast(duration = 4200) {
    const toastMessage = ref('');
    let toastTimer = 0;

    function showToast(message) {
        toastMessage.value = message;
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => {
            toastMessage.value = '';
        }, duration);
    }

    return {
        toastMessage,
        showToast
    };
}
