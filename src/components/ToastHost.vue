<template>
    <div class="toast" :class="{ show: Boolean(message) }" role="status" aria-live="polite">
        {{ message }}
    </div>
</template>

<script setup>
defineProps({
    message: { type: String, default: '' }
});
</script>
